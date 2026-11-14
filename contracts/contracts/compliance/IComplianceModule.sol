// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IComplianceModule
/// @notice A single transfer rule. Modules hold configuration only; all holdings data is read
///         from the token, so a module can be added to or removed from a live token at any time.
interface IComplianceModule {
    /// @notice True when the rule accepts moving `amount` of `token` from `from` to `to`.
    /// @dev `from` is the zero address for a mint.
    function moduleCheck(address token, address from, address to, uint256 amount) external view returns (bool);

    /// @notice Human-readable rule name.
    function name() external pure returns (string memory);
}
