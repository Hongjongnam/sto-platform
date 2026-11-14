// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title IdentityRegistry
/// @notice Maps wallets to investors using claims signed off-chain by trusted KYC issuers.
/// @dev A simplified take on the ERC-3643 identity layer: instead of an on-chain identity
///      contract per investor, a trusted issuer signs an EIP-712 claim and a registrar submits it.
///      No personal data is stored; `investorId` is an opaque hash of an off-chain identifier.
contract IdentityRegistry is IIdentityRegistry, AccessControl, EIP712 {
    /// @notice Investor categories. Stored as `uint8`.
    enum InvestorType {
        Retail,
        Qualified,
        Professional
    }

    /// @notice Data signed by a trusted issuer, together with the wallet's current nonce.
    struct Claim {
        address wallet;
        bytes32 investorId;
        uint16 country;
        uint8 investorType;
        uint64 expiry;
    }

    struct Identity {
        bytes32 investorId;
        uint64 expiry;
        uint16 country;
        uint8 investorType;
        bool revoked;
    }

    /// @notice Submits and revokes identities.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "InvestorClaim(address wallet,bytes32 investorId,uint16 country,uint8 investorType,uint64 expiry,uint256 nonce)"
        );

    mapping(address wallet => Identity) private _identities;
    mapping(address issuer => bool) private _trustedIssuers;
    mapping(address wallet => uint256) private _nonces;

    event IdentityRegistered(
        address indexed wallet,
        bytes32 indexed investorId,
        uint16 country,
        uint8 investorType,
        uint64 expiry,
        address indexed issuer,
        address operator
    );
    event IdentityRevoked(address indexed wallet, bytes32 indexed investorId, address indexed operator, bytes32 reason);
    event TrustedIssuerSet(address indexed issuer, bool trusted, address indexed operator);

    error ZeroAddress();
    error ZeroInvestorId();
    error InvalidInvestorType(uint8 investorType);
    error ClaimExpired(uint64 expiry);
    error UntrustedIssuer(address signer);
    error InvestorMismatch(address wallet, bytes32 current, bytes32 claimed);
    error IdentityNotFound(address wallet);
    error AlreadyRevoked(address wallet);

    constructor(address admin) EIP712("IdentityRegistry", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Adds or removes a KYC issuer whose signatures are accepted.
    /// @dev Removing an issuer does not invalidate identities it already signed; they stay
    ///      valid until they expire or are revoked.
    function setTrustedIssuer(address issuer, bool trusted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (issuer == address(0)) revert ZeroAddress();
        _trustedIssuers[issuer] = trusted;
        emit TrustedIssuerSet(issuer, trusted, msg.sender);
    }

    /// @notice Registers or renews an identity from a claim signed by a trusted issuer.
    /// @dev The claim is bound to this contract and chain through the EIP-712 domain and to a
    ///      per-wallet nonce, so a signature can be used exactly once. A wallet stays linked to
    ///      the investor it was first registered for; renewals must carry the same `investorId`.
    /// @param claim Wallet, investor, ISO 3166-1 numeric country, `InvestorType` and expiry time.
    /// @param signature Issuer signature over the `InvestorClaim` typed data.
    function registerIdentity(Claim calldata claim, bytes calldata signature) external onlyRole(REGISTRAR_ROLE) {
        if (claim.wallet == address(0)) revert ZeroAddress();
        if (claim.investorId == bytes32(0)) revert ZeroInvestorId();
        if (claim.investorType > uint8(type(InvestorType).max)) revert InvalidInvestorType(claim.investorType);
        if (claim.expiry <= block.timestamp) revert ClaimExpired(claim.expiry);

        Identity storage identity = _identities[claim.wallet];
        if (identity.investorId != bytes32(0) && identity.investorId != claim.investorId) {
            revert InvestorMismatch(claim.wallet, identity.investorId, claim.investorId);
        }

        address signer = ECDSA.recover(_hashTypedDataV4(_hashClaim(claim, _nonces[claim.wallet]++)), signature);
        if (!_trustedIssuers[signer]) revert UntrustedIssuer(signer);

        identity.investorId = claim.investorId;
        identity.expiry = claim.expiry;
        identity.country = claim.country;
        identity.investorType = claim.investorType;
        identity.revoked = false;

        emit IdentityRegistered(
            claim.wallet,
            claim.investorId,
            claim.country,
            claim.investorType,
            claim.expiry,
            signer,
            msg.sender
        );
    }

    /// @notice Revokes the identity of `wallet`. The wallet stays linked to its investor.
    /// @param reason Application-defined reason code recorded in the event.
    function revokeIdentity(address wallet, bytes32 reason) external onlyRole(REGISTRAR_ROLE) {
        Identity storage identity = _identities[wallet];
        if (identity.investorId == bytes32(0)) revert IdentityNotFound(wallet);
        if (identity.revoked) revert AlreadyRevoked(wallet);
        identity.revoked = true;
        emit IdentityRevoked(wallet, identity.investorId, msg.sender, reason);
    }

    /// @inheritdoc IIdentityRegistry
    function isVerified(address wallet) external view returns (bool) {
        Identity storage identity = _identities[wallet];
        return identity.investorId != bytes32(0) && !identity.revoked && identity.expiry > block.timestamp;
    }

    /// @inheritdoc IIdentityRegistry
    function investorOf(address wallet) external view returns (bytes32) {
        return _identities[wallet].investorId;
    }

    /// @inheritdoc IIdentityRegistry
    function investorTypeOf(address wallet) external view returns (uint8) {
        return _identities[wallet].investorType;
    }

    /// @inheritdoc IIdentityRegistry
    function countryOf(address wallet) external view returns (uint16) {
        return _identities[wallet].country;
    }

    /// @notice Full identity record of `wallet`.
    function identityOf(address wallet) external view returns (Identity memory) {
        return _identities[wallet];
    }

    function _hashClaim(Claim calldata claim, uint256 nonce) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH,
                    claim.wallet,
                    claim.investorId,
                    claim.country,
                    claim.investorType,
                    claim.expiry,
                    nonce
                )
            );
    }

    /// @notice Whether `issuer` is currently trusted to sign claims.
    function isTrustedIssuer(address issuer) external view returns (bool) {
        return _trustedIssuers[issuer];
    }

    /// @notice Nonce the next claim for `wallet` must carry.
    function nonces(address wallet) external view returns (uint256) {
        return _nonces[wallet];
    }
}
