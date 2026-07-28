// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable ERC-20 used only by the local integration test fixture.
/// Anyone can mint themselves test tokens via the public faucet() function.
/// Never deploy this contract as a public trading asset.
contract TestERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    /// @notice Public faucet for local test setup only.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}
