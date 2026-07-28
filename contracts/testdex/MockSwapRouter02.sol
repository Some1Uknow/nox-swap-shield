// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3SwapRouter02} from "../interfaces/IUniswapV3SwapRouter02.sol";

/// @dev Test-only 7-field SwapRouter02 implementation. It is intentionally
/// separate from DemoAMM so the adapter test covers the real ABI difference.
contract MockSwapRouter02 is IUniswapV3SwapRouter02 {
    using SafeERC20 for IERC20;

    address public immutable tokenA;
    address public immutable tokenB;
    uint256 public reserveA;
    uint256 public reserveB;
    uint256 public constant FEE_BPS = 30;

    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != _tokenB, "identical tokens");
        tokenA = _tokenA;
        tokenB = _tokenB;
    }

    function addLiquidity(uint256 amountA, uint256 amountB) external {
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountB);
        reserveA += amountA;
        reserveB += amountB;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(msg.value == 0, "native value unsupported");
        require(
            (params.tokenIn == tokenA && params.tokenOut == tokenB) ||
                (params.tokenIn == tokenB && params.tokenOut == tokenA),
            "unsupported pair"
        );

        bool inIsA = params.tokenIn == tokenA;
        (uint256 reserveIn, uint256 reserveOut) = inIsA ? (reserveA, reserveB) : (reserveB, reserveA);
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        uint256 amountInWithFee = params.amountIn * (10_000 - FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10_000 + amountInWithFee);
        require(amountOut >= params.amountOutMinimum, "slippage");

        if (inIsA) {
            reserveA += params.amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += params.amountIn;
            reserveA -= amountOut;
        }
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
