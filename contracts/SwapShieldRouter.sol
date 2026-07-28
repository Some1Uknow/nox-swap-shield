// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {
    Nox,
    ebool,
    euint256,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ShieldedToken} from "./ShieldedToken.sol";
import {IAmmRouter} from "./interfaces/IAmmRouter.sol";

/// @title SwapShieldRouter
/// @notice Batches confidential ERC-7984 swap intents and executes one aggregate
///         swap against a transparent AMM. Individual input sizes stay encrypted;
///         only the aggregate is unwrapped at settlement.
/// @dev Settlement is deliberately restricted to a configured executor. It must
///      use a private transaction relay for both preparation and settlement.
///      This reduces public-mempool exposure, but does not make the aggregate
///      permanently private after an unwrap request is mined. The executor
///      cannot redirect funds: all outputs are allocated to the order traders
///      and expired batches are permissionlessly refundable.
contract SwapShieldRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint48 public constant MAX_ORDER_LIFETIME = 30 minutes;
    // A batch requires one private transaction to create the aggregate unwrap
    // request and a second one to settle it after the gateway returns a proof.
    // Do not let an almost-expired order create a batch that cannot reasonably
    // complete without exposing a public-settlement fallback.
    uint48 public constant MIN_BATCH_SETTLEMENT_WINDOW = 5 minutes;
    // Confidential arithmetic and ERC-7984 transfers are performed once per
    // order during settlement. Keep this conservative until a target chain's
    // gas ceiling has been benchmarked with the exact deployed Nox stack.
    uint256 public constant MAX_BATCH_SIZE_HARD_CAP = 12;

    enum OrderStatus {
        None,
        Pending,
        Active,
        Prepared,
        Settled,
        Cancelled
    }

    enum BatchStatus {
        None,
        Prepared,
        Settled,
        Refunded
    }

    struct Order {
        address trader;
        euint256 inputAmount;
        ebool fundingCheck;
        uint256 minOut;
        uint48 deadline;
        uint256 batchId;
        OrderStatus status;
    }

    struct Batch {
        euint256 unwrapRequestId;
        uint256 totalMinOut;
        uint48 deadline;
        uint32 orderCount;
        BatchStatus status;
    }

    error InvalidAddress();
    error InvalidBatchSize();
    error InvalidDeadline();
    error InvalidMinimumOutput();
    error IncompatibleShieldedToken();
    error DuplicateTraderInBatch();
    error UnauthorizedExecutor();
    error UnknownOrder();
    error OrderNotActive();
    error OrderNotPending();
    error OrderNotCancellable();
    error BatchNotPrepared();
    error BatchNotExpired();
    error BatchDeadlineTooSoon();
    error EmptySettlement();
    error IncompleteSwap();

    ShieldedToken public immutable shieldedTokenIn;
    ShieldedToken public immutable shieldedTokenOut;
    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;
    IAmmRouter public immutable ammRouter;
    uint24 public immutable poolFee;
    address public immutable settlementExecutor;
    uint256 public immutable minBatchSize;
    uint256 public immutable maxBatchSize;

    uint256 public nextOrderId;
    uint256 public nextBatchId;
    mapping(uint256 orderId => Order order) public orders;
    mapping(uint256 batchId => Batch batch) public batches;
    mapping(uint256 batchId => uint256[] orderIds) private _batchOrderIds;

    event OrderSubmitted(
        uint256 indexed orderId,
        address indexed trader,
        uint48 deadline
    );
    event OrderActivated(uint256 indexed orderId, address indexed trader);
    event OrderRejected(uint256 indexed orderId, address indexed trader);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event BatchPrepared(
        uint256 indexed batchId,
        uint32 orderCount,
        uint256 totalMinOut,
        uint48 deadline
    );
    event BatchSettled(uint256 indexed batchId);
    event BatchRefunded(uint256 indexed batchId);

    modifier onlyExecutor() {
        if (msg.sender != settlementExecutor) revert UnauthorizedExecutor();
        _;
    }

    constructor(
        ShieldedToken _shieldedTokenIn,
        ShieldedToken _shieldedTokenOut,
        IERC20 _tokenIn,
        IERC20 _tokenOut,
        IAmmRouter _ammRouter,
        uint24 _poolFee,
        address _settlementExecutor,
        uint256 _minBatchSize,
        uint256 _maxBatchSize
    ) {
        if (
            address(_shieldedTokenIn) == address(0) ||
            address(_shieldedTokenOut) == address(0) ||
            address(_tokenIn) == address(0) ||
            address(_tokenOut) == address(0) ||
            address(_ammRouter) == address(0) ||
            _settlementExecutor == address(0)
        ) revert InvalidAddress();
        if (
            address(_shieldedTokenIn).code.length == 0 ||
            address(_shieldedTokenOut).code.length == 0 ||
            address(_tokenIn).code.length == 0 ||
            address(_tokenOut).code.length == 0 ||
            address(_ammRouter).code.length == 0
        ) revert InvalidAddress();
        if (address(_tokenIn) == address(_tokenOut) || address(_shieldedTokenIn) == address(_shieldedTokenOut)) {
            revert InvalidAddress();
        }
        if (
            _shieldedTokenIn.underlying() != address(_tokenIn) ||
            _shieldedTokenOut.underlying() != address(_tokenOut)
        ) revert IncompatibleShieldedToken();
        if (
            _poolFee == 0 ||
            _minBatchSize < 3 ||
            _maxBatchSize < _minBatchSize ||
            _maxBatchSize > MAX_BATCH_SIZE_HARD_CAP
        ) revert InvalidBatchSize();

        shieldedTokenIn = _shieldedTokenIn;
        shieldedTokenOut = _shieldedTokenOut;
        tokenIn = _tokenIn;
        tokenOut = _tokenOut;
        ammRouter = _ammRouter;
        poolFee = _poolFee;
        settlementExecutor = _settlementExecutor;
        minBatchSize = _minBatchSize;
        maxBatchSize = _maxBatchSize;
    }

    /// @notice Attempts to deposit an encrypted amount from the caller's
    ///         confidential input balance. The caller must first make this
    ///         router an ERC-7984 operator; no plaintext input amount is
    ///         submitted to this method.
    /// @dev ERC-7984 safe transfers return encrypted zero instead of reverting
    ///      for an insufficient confidential balance. The order is therefore
    ///      Pending until a public proof confirms that a nonzero transfer took
    ///      place. This prevents unfunded encrypted orders from poisoning a
    ///      batch's aggregate minimum output.
    function submitOrder(
        externalEuint256 encryptedAmount,
        bytes calldata inputProof,
        uint256 minOut,
        uint48 deadline
    ) external nonReentrant returns (uint256 orderId) {
        if (minOut == 0) revert InvalidMinimumOutput();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_ORDER_LIFETIME) {
            revert InvalidDeadline();
        }

        // The router validates the proof while msg.sender is still the trader,
        // binding the gateway proof to this router and that trader. Nox grants
        // the router transient access to the handle; give the ShieldedToken
        // the same transaction-scoped access before it performs encrypted
        // arithmetic. The token returns encrypted zero on an insufficient
        // balance rather than reverting.
        euint256 requestedAmount = Nox.fromExternal(encryptedAmount, inputProof);
        Nox.allowTransient(requestedAmount, address(shieldedTokenIn));
        euint256 transferred = shieldedTokenIn.confidentialTransferFrom(
            msg.sender,
            address(this),
            requestedAmount
        );
        // ERC-7984 returns a transiently permitted handle to the calling router.
        // Persist router access before storing that handle for a later batch.
        Nox.allowThis(transferred);
        ebool fundingCheck = Nox.gt(transferred, Nox.toEuint256(0));
        // This reveals only whether the confidential transfer was nonzero, not
        // its value. Anyone can later submit the proof that activates/rejects
        // the pending order.
        Nox.allowPublicDecryption(fundingCheck);

        orderId = nextOrderId++;
        orders[orderId] = Order({
            trader: msg.sender,
            inputAmount: transferred,
            fundingCheck: fundingCheck,
            minOut: minOut,
            deadline: deadline,
            batchId: 0,
            status: OrderStatus.Pending
        });

        emit OrderSubmitted(orderId, msg.sender, deadline);
    }

    /// @notice Turns a funded pending order into an active order, or rejects an
    ///         unfunded/expired one. The proof attests only to a boolean funding
    ///         check; it does not disclose the requested amount.
    function validateOrder(uint256 orderId, bytes calldata fundingProof) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.trader == address(0)) revert UnknownOrder();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        bool funded = Nox.publicDecrypt(order.fundingCheck, fundingProof);
        if (!funded) {
            order.status = OrderStatus.Cancelled;
            emit OrderRejected(orderId, order.trader);
            return;
        }
        if (block.timestamp >= order.deadline) {
            _cancelOrder(orderId, order);
            return;
        }

        order.status = OrderStatus.Active;
        emit OrderActivated(orderId, order.trader);
    }

    /// @notice Returns confidential input to the trader before batching, or to
    ///         anyone's benefit after an order expires. Refunds always go to the
    ///         original trader.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.trader == address(0)) revert UnknownOrder();
        if (order.status != OrderStatus.Pending && order.status != OrderStatus.Active) {
            revert OrderNotCancellable();
        }
        if (msg.sender != order.trader && block.timestamp <= order.deadline) {
            revert OrderNotCancellable();
        }

        _cancelOrder(orderId, order);
    }

    /// @notice Creates one aggregate confidential unwrap request for a bounded
    ///         set of active orders.
    /// @dev Individual amounts remain encrypted, but the resulting aggregate is
    ///      publicly decryptable once this transaction is mined. Submit only
    ///      through a private relay and pair it with a prompt private settlement.
    function prepareBatch(uint256[] calldata orderIds)
        external
        onlyExecutor
        nonReentrant
        returns (uint256 batchId)
    {
        uint256 orderCount = orderIds.length;
        if (orderCount < minBatchSize || orderCount > maxBatchSize) revert InvalidBatchSize();

        batchId = nextBatchId++;
        euint256 totalInput = Nox.toEuint256(0);
        uint256 totalMinOut;
        uint48 batchDeadline = type(uint48).max;

        for (uint256 i = 0; i < orderCount; ++i) {
            Order storage order = orders[orderIds[i]];
            if (
                order.trader == address(0) ||
                order.status != OrderStatus.Active ||
                order.deadline <= block.timestamp
            ) revert OrderNotActive();
            if (order.deadline <= block.timestamp + MIN_BATCH_SETTLEMENT_WINDOW) {
                revert BatchDeadlineTooSoon();
            }
            // Require distinct wallet addresses so one account cannot satisfy
            // the batching threshold by splitting a position into many orders.
            // This improves the anonymity set but is not Sybil resistance:
            // one person can still control multiple addresses.
            for (uint256 j = 0; j < i; ++j) {
                if (orders[orderIds[j]].trader == order.trader) {
                    revert DuplicateTraderInBatch();
                }
            }

            order.status = OrderStatus.Prepared;
            order.batchId = batchId;
            _batchOrderIds[batchId].push(orderIds[i]);

            totalInput = Nox.add(totalInput, order.inputAmount);
            Nox.allowThis(totalInput);
            totalMinOut += order.minOut;
            if (order.deadline < batchDeadline) batchDeadline = order.deadline;
        }

        // The wrapper executes the encrypted burn internally, so it needs
        // transaction-scoped access to the aggregate in addition to the
        // router's persistent access.
        Nox.allowTransient(totalInput, address(shieldedTokenIn));
        euint256 unwrapRequestId = shieldedTokenIn.unwrap(address(this), address(this), totalInput);
        batches[batchId] = Batch({
            unwrapRequestId: unwrapRequestId,
            totalMinOut: totalMinOut,
            deadline: batchDeadline,
            orderCount: uint32(orderCount),
            status: BatchStatus.Prepared
        });

        emit BatchPrepared(batchId, uint32(orderCount), totalMinOut, batchDeadline);
    }

    /// @notice Finalizes one aggregate unwrap, swaps it through the configured
    ///         AMM, wraps the aggregate output, and allocates encrypted output
    ///         balances to every trader. Call only through a private relay.
    function settleBatch(uint256 batchId, bytes calldata decryptedAmountAndProof)
        external
        onlyExecutor
        nonReentrant
    {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.Prepared) revert BatchNotPrepared();
        if (block.timestamp > batch.deadline) revert InvalidDeadline();

        uint256 inputBalanceBefore = tokenIn.balanceOf(address(this));
        shieldedTokenIn.finalizeUnwrap(batch.unwrapRequestId, decryptedAmountAndProof);
        uint256 amountIn = tokenIn.balanceOf(address(this)) - inputBalanceBefore;
        if (amountIn == 0) revert EmptySettlement();

        // Checks-effects-interactions: an AMM callback cannot settle/refund this
        // batch twice, and the reentrancy guard protects every external entrypoint.
        batch.status = BatchStatus.Settled;

        tokenIn.forceApprove(address(ammRouter), amountIn);
        uint256 outputBalanceBefore = tokenOut.balanceOf(address(this));
        ammRouter.exactInputSingle(
            IAmmRouter.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                fee: poolFee,
                recipient: address(this),
                deadline: batch.deadline,
                amountIn: amountIn,
                amountOutMinimum: batch.totalMinOut,
                sqrtPriceLimitX96: 0
            })
        );
        tokenIn.forceApprove(address(ammRouter), 0);
        if (tokenIn.balanceOf(address(this)) != inputBalanceBefore) revert IncompleteSwap();
        uint256 amountOut = tokenOut.balanceOf(address(this)) - outputBalanceBefore;
        if (amountOut < batch.totalMinOut) revert IncompleteSwap();

        tokenOut.forceApprove(address(shieldedTokenOut), amountOut);
        euint256 encryptedAmountOut = shieldedTokenOut.wrap(address(this), amountOut);
        tokenOut.forceApprove(address(shieldedTokenOut), 0);
        Nox.allowThis(encryptedAmountOut);

        _allocateBatchOutput(batchId, amountIn, amountOut, encryptedAmountOut);
        emit BatchSettled(batchId);
    }

    /// @notice After an unfilled batch expires, anyone can reveal its aggregate
    ///         request and re-wrap/refund each trader's original confidential
    ///         input. This removes the permanent-funds-lock failure mode.
    function refundExpiredBatch(uint256 batchId, bytes calldata decryptedAmountAndProof)
        external
        nonReentrant
    {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.Prepared) revert BatchNotPrepared();
        if (block.timestamp <= batch.deadline) revert BatchNotExpired();

        batch.status = BatchStatus.Refunded;

        uint256 inputBalanceBefore = tokenIn.balanceOf(address(this));
        shieldedTokenIn.finalizeUnwrap(batch.unwrapRequestId, decryptedAmountAndProof);
        uint256 amountIn = tokenIn.balanceOf(address(this)) - inputBalanceBefore;
        if (amountIn == 0) revert EmptySettlement();

        tokenIn.forceApprove(address(shieldedTokenIn), amountIn);
        shieldedTokenIn.wrap(address(this), amountIn);
        tokenIn.forceApprove(address(shieldedTokenIn), 0);

        uint256[] storage orderIds = _batchOrderIds[batchId];
        for (uint256 i = 0; i < orderIds.length; ++i) {
            Order storage order = orders[orderIds[i]];
            order.status = OrderStatus.Cancelled;
            // ERC-7984 performs the encrypted transfer inside the wrapper.
            // Give it access only for this transaction; the router remains the
            // sole persistent holder of every order amount.
            Nox.allowTransient(order.inputAmount, address(shieldedTokenIn));
            shieldedTokenIn.confidentialTransfer(order.trader, order.inputAmount);
            emit OrderCancelled(orderIds[i], order.trader);
        }

        emit BatchRefunded(batchId);
    }

    function getBatchOrderIds(uint256 batchId) external view returns (uint256[] memory) {
        return _batchOrderIds[batchId];
    }

    function _cancelOrder(uint256 orderId, Order storage order) internal {
        order.status = OrderStatus.Cancelled;
        Nox.allowTransient(order.inputAmount, address(shieldedTokenIn));
        shieldedTokenIn.confidentialTransfer(order.trader, order.inputAmount);
        emit OrderCancelled(orderId, order.trader);
    }

    function _allocateBatchOutput(
        uint256 batchId,
        uint256 amountIn,
        uint256 amountOut,
        euint256 encryptedAmountOut
    ) internal {
        uint256[] storage orderIds = _batchOrderIds[batchId];
        euint256 encryptedTotalInput = Nox.toEuint256(amountIn);
        euint256 encryptedSurplus = Nox.toEuint256(amountOut - batches[batchId].totalMinOut);
        euint256 encryptedAllocated = Nox.toEuint256(0);

        for (uint256 i = 0; i < orderIds.length; ++i) {
            Order storage order = orders[orderIds[i]];
            euint256 allocation;

            if (i + 1 == orderIds.length) {
                // Give rounding dust to the final trader so every wrapped output
                // token is allocated and every previous trader received minOut.
                allocation = Nox.sub(encryptedAmountOut, encryptedAllocated);
            } else {
                euint256 encryptedMinimum = Nox.toEuint256(order.minOut);
                euint256 proRataSurplus = Nox.div(
                    Nox.mul(order.inputAmount, encryptedSurplus),
                    encryptedTotalInput
                );
                allocation = Nox.add(encryptedMinimum, proRataSurplus);
                encryptedAllocated = Nox.add(encryptedAllocated, allocation);
                Nox.allowThis(encryptedAllocated);
            }

            Nox.allowThis(allocation);
            Nox.allowTransient(allocation, address(shieldedTokenOut));
            shieldedTokenOut.confidentialTransfer(order.trader, allocation);
            order.status = OrderStatus.Settled;
        }
    }
}
