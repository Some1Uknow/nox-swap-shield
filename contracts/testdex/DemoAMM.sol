// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAmmRouter} from "../interfaces/IAmmRouter.sol";

/// @notice A minimal constant-product (x*y=k) two-token pool exposing a
/// Uniswap-V3-shaped `exactInputSingle` entrypoint. It exists exclusively for
/// local integration tests against Nox; scripts/deploy.ts will never deploy it.
///
/// This is NOT a production AMM: it has no LP-token accounting, no fee-accrual
/// accounting, and no protection against first-depositor donation attacks.
/// Do not use it for a public demo, trading, or any deployed environment.
contract DemoAMM is IAmmRouter {
    using SafeERC20 for IERC20;

    address public immutable tokenA;
    address public immutable tokenB;
    uint256 public reserveA;
    uint256 public reserveB;
    uint256 public constant FEE_BPS = 30; // 0.30%, matches the common Uniswap fee tier

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB);
    event Swap(address indexed trader, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != _tokenB, "identical tokens");
        tokenA = _tokenA;
        tokenB = _tokenB;
    }

    /// @notice Seed or top up the pool. Open to anyone (testnet only).
    function addLiquidity(uint256 amountA, uint256 amountB) external {
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountB);
        reserveA += amountA;
        reserveB += amountB;
        emit LiquidityAdded(msg.sender, amountA, amountB);
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        require(msg.value == 0, "native value unsupported");
        require(block.timestamp <= params.deadline, "expired");
        require(
            (params.tokenIn == tokenA && params.tokenOut == tokenB) ||
                (params.tokenIn == tokenB && params.tokenOut == tokenA),
            "unsupported pair"
        );
        require(params.amountIn > 0, "zero amountIn");

        bool inIsA = params.tokenIn == tokenA;
        (uint256 reserveIn, uint256 reserveOut) = inIsA ? (reserveA, reserveB) : (reserveB, reserveA);
        require(reserveIn > 0 && reserveOut > 0, "pool not seeded");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        uint256 amountInWithFee = params.amountIn * (10_000 - FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10_000 + amountInWithFee);

        require(amountOut >= params.amountOutMinimum, "slippage: amountOut below minimum");

        if (inIsA) {
            reserveA += params.amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += params.amountIn;
            reserveA -= amountOut;
        }

        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        emit Swap(msg.sender, params.tokenIn, params.amountIn, amountOut);
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserveA, reserveB);
    }
}
