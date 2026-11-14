// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "../identity/IIdentityRegistry.sol";

/// @title ISecurityToken
/// @notice Security-token functions used by compliance modules and corporate-action contracts,
///         in addition to the ERC-20 interface.
interface ISecurityToken {
    /// @notice Registry that resolves wallets to investors.
    function identityRegistry() external view returns (IIdentityRegistry);

    /// @notice Combined balance of every wallet linked to `investorId`.
    function investorBalanceOf(bytes32 investorId) external view returns (uint256);

    /// @notice Number of investors with a non-zero combined balance.
    function holderCount() external view returns (uint256);

    /// @notice Whether `account` is frozen entirely.
    function isFrozen(address account) external view returns (bool);

    /// @notice Amount of `account`'s balance that is frozen.
    function getFrozenTokens(address account) external view returns (uint256);

    /// @notice Balance of `account` that is not frozen.
    function freeBalanceOf(address account) external view returns (uint256);

    /// @notice Balance of `account` at the end of block `blockNumber`.
    function balanceOfAt(address account, uint256 blockNumber) external view returns (uint256);

    /// @notice Total supply at the end of block `blockNumber`.
    function totalSupplyAt(uint256 blockNumber) external view returns (uint256);

    /// @notice Issues `amount` to `to`.
    function mint(address to, uint256 amount, bytes32 reason) external;

    /// @notice Cancels `amount` held by `from`.
    function burn(address from, uint256 amount, bytes32 reason) external;
}
