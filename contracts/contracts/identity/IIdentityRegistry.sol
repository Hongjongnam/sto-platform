// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice Read interface used by tokens and compliance modules to resolve a wallet to an investor.
interface IIdentityRegistry {
    /// @notice True when `wallet` has a registered identity that is neither revoked nor expired.
    function isVerified(address wallet) external view returns (bool);

    /// @notice Investor that `wallet` belongs to, or zero if the wallet was never registered.
    /// @dev The link is kept after revocation and expiry so that balances held by the wallet
    ///      can still be attributed to an investor.
    function investorOf(address wallet) external view returns (bytes32);

    /// @notice Investor category of `wallet` (see `IdentityRegistry.InvestorType`).
    function investorTypeOf(address wallet) external view returns (uint8);

    /// @notice ISO 3166-1 numeric country code of `wallet`.
    function countryOf(address wallet) external view returns (uint16);
}
