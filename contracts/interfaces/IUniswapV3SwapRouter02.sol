// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice The single-hop ERC-20 swap surface exposed by Uniswap's deployed
/// SwapRouter02 contract. Unlike the original V3 SwapRouter, this ABI does
/// not include a deadline in the parameter struct.
interface IUniswapV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
