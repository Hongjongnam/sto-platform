// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title USDC
/// @notice 6-decimal stablecoin used as the cash leg in tests and local networks.
/// @dev Minting is unrestricted. Never deploy to a network that holds real value.
contract USDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints `amount` to `to`.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
