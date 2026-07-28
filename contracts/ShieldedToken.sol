// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ToERC7984Wrapper} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Nox ERC-7984 wrapper around one standard ERC-20.
/// @dev Deposits are public ERC-20 transfers. Applications should decouple a
///      deposit from a specific order if they need to avoid that correlation.
///      SwapShieldRouter uses confidential transfers for individual orders and
///      unwraps only an aggregate batch at settlement.
contract ShieldedToken is ERC20ToERC7984Wrapper {
    constructor(IERC20 underlyingToken, string memory name_, string memory symbol_)
        ERC20ToERC7984Wrapper(name_, symbol_, "", underlyingToken)
    {}
}
