// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICompliance
/// @notice Decides whether a mint or transfer of a security token is allowed.
interface ICompliance {
    /// @notice True when every active rule accepts moving `amount` of `token` from `from` to `to`.
    /// @dev `from` is the zero address for a mint.
    function canTransfer(address token, address from, address to, uint256 amount) external view returns (bool);
}
