// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAmmRouter} from "./interfaces/IAmmRouter.sol";
import {IUniswapV3SwapRouter02} from "./interfaces/IUniswapV3SwapRouter02.sol";

/// @title UniswapV3SwapRouter02Adapter
/// @notice Bridges Swap Shield's deadline-bearing AMM interface to Uniswap's
/// deployed SwapRouter02 ABI without changing either upstream contract.
/// @dev The adapter pulls exactly `amountIn` from SwapShieldRouter, grants a
/// short-lived allowance to the immutable official router, and forwards the
/// output directly to the requested recipient. It deliberately supports only
/// ERC-20 input; Swap Shield itself does not settle native-ETH orders.
contract UniswapV3SwapRouter02Adapter is IAmmRouter {
    using SafeERC20 for IERC20;

    error InvalidRouter();
    error NativeValueUnsupported();
    error Expired();
    error IncompleteInputPull();

    IUniswapV3SwapRouter02 public immutable swapRouter02;

    constructor(IUniswapV3SwapRouter02 _swapRouter02) {
        if (address(_swapRouter02) == address(0) || address(_swapRouter02).code.length == 0) {
            revert InvalidRouter();
        }
        swapRouter02 = _swapRouter02;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        if (msg.value != 0) revert NativeValueUnsupported();
        if (block.timestamp > params.deadline) revert Expired();

        IERC20 tokenIn = IERC20(params.tokenIn);
        uint256 adapterInputBalanceBefore = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), params.amountIn);
        if (tokenIn.balanceOf(address(this)) != adapterInputBalanceBefore + params.amountIn) {
            revert IncompleteInputPull();
        }

        tokenIn.forceApprove(address(swapRouter02), params.amountIn);
        amountOut = swapRouter02.exactInputSingle(
            IUniswapV3SwapRouter02.ExactInputSingleParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                fee: params.fee,
                recipient: params.recipient,
                amountIn: params.amountIn,
                amountOutMinimum: params.amountOutMinimum,
                sqrtPriceLimitX96: params.sqrtPriceLimitX96
            })
        );
        tokenIn.forceApprove(address(swapRouter02), 0);
        if (tokenIn.balanceOf(address(this)) != adapterInputBalanceBefore) revert IncompleteInputPull();
    }
}
