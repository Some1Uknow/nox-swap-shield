// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal swap interface modeled on Uniswap V3's ISwapRouter.exactInputSingle.
/// SwapShieldRouter is written against this interface so a production deployment
/// can target an existing compatible AMM router without changing router logic.
/// The bundled DemoAMM implements this interface only for local tests.
interface IAmmRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
