// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IIdentityRegistry} from "../identity/IIdentityRegistry.sol";
import {ICompliance} from "../compliance/ICompliance.sol";
import {ISecurityToken} from "./ISecurityToken.sol";

/// @title SecurityToken
/// @notice Permissioned security token following the ERC-3643 model: only verified investors
///         can hold it, every movement is checked against compliance rules, and authorised
///         operators can freeze, force-transfer and recover balances.
/// @dev UUPS upgradeable with ERC-7201 namespaced storage.
///
///      All ordinary movements (transfer, mint, burn) are validated in `_update`. The only
///      paths that skip validation are `forcedTransfer` and `recoveryAddress`, which go through
///      `_move`. Both paths end in `_afterMove`, which records checkpoints and keeps the
///      per-investor aggregates in sync.
contract SecurityToken is
    ISecurityToken,
    ERC20Upgradeable,
    AccessControlDefaultAdminRulesUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using Checkpoints for Checkpoints.Trace208;

    /// @notice Issues and cancels tokens.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    /// @notice Freezes accounts and balances, forces transfers and recovers wallets.
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");
    /// @notice Pauses and unpauses ordinary movements.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Sets the registered supply, the ceiling for issuance.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @notice Authorises implementation upgrades.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @custom:storage-location erc7201:sto.storage.SecurityToken
    struct TokenStorage {
        IIdentityRegistry identityRegistry;
        ICompliance compliance;
        uint256 registeredSupply;
        uint256 holderCount;
        mapping(address account => bool) frozen;
        mapping(address account => uint256) frozenTokens;
        mapping(bytes32 investorId => uint256) investorBalance;
        mapping(address account => Checkpoints.Trace208) balanceCheckpoints;
        Checkpoints.Trace208 supplyCheckpoints;
    }

    // keccak256(abi.encode(uint256(keccak256("sto.storage.SecurityToken")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x55fa14fbf49b57aa4e96ac4f9dfe409b5e3be47861815e7356d729765cb27d00;

    event Issued(address indexed to, uint256 amount, address indexed operator, bytes32 reason);
    event Redeemed(address indexed from, uint256 amount, address indexed operator, bytes32 reason);
    event AddressFrozen(address indexed account, bool frozen, address indexed operator, bytes32 reason);
    event TokensFrozen(address indexed account, uint256 amount, address indexed operator, bytes32 reason);
    event TokensUnfrozen(address indexed account, uint256 amount, address indexed operator, bytes32 reason);
    event ForcedTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        address indexed operator,
        bytes32 reason
    );
    event RecoverySuccess(
        address indexed lostWallet,
        address indexed newWallet,
        bytes32 indexed investorId,
        uint256 amount,
        address operator,
        bytes32 reason
    );
    event PauseStateChanged(bool paused, address indexed operator, bytes32 reason);
    event RegisteredSupplySet(uint256 previous, uint256 current, address indexed operator, bytes32 reason);
    event ComplianceSet(address indexed previous, address indexed current, address indexed operator);

    error ZeroAddress();
    error NotVerified(address account);
    error AccountFrozen(address account);
    error InsufficientFreeBalance(address account, uint256 free, uint256 needed);
    error InsufficientFrozenBalance(address account, uint256 frozen, uint256 needed);
    error ComplianceRejected(address from, address to, uint256 amount);
    error RegisteredSupplyExceeded(uint256 supply, uint256 registeredSupply);
    error RegisteredSupplyBelowTotalSupply(uint256 requested, uint256 totalSupply);
    error InvestorMismatch(address lostWallet, address newWallet);
    error SameWallet();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param admin Holder of the default admin role.
    /// @param adminTransferDelay Seconds an admin transfer must wait before it can be accepted.
    /// @param registry Identity registry; fixed for the life of the token.
    /// @param compliance_ Initial compliance contract.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address admin,
        uint48 adminTransferDelay,
        IIdentityRegistry registry,
        ICompliance compliance_
    ) external initializer {
        if (address(registry) == address(0) || address(compliance_) == address(0)) revert ZeroAddress();
        __ERC20_init(name_, symbol_);
        __AccessControlDefaultAdminRules_init(adminTransferDelay, admin);
        __Pausable_init();
        TokenStorage storage $ = _getStorage();
        $.identityRegistry = registry;
        $.compliance = compliance_;
        emit ComplianceSet(address(0), address(compliance_), msg.sender);
    }

    /// @notice Securities are whole units.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ───────── Issuance ─────────

    /// @inheritdoc ISecurityToken
    /// @dev The receiver must be verified, not frozen and accepted by compliance, and the new
    ///      total supply may not exceed the registered supply.
    function mint(address to, uint256 amount, bytes32 reason) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
        emit Issued(to, amount, msg.sender, reason);
    }

    /// @inheritdoc ISecurityToken
    /// @dev Only the free balance of an account that is not frozen can be cancelled; frozen
    ///      amounts must be unfrozen first.
    function burn(address from, uint256 amount, bytes32 reason) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount);
        emit Redeemed(from, amount, msg.sender, reason);
    }

    /// @notice Sets the registered supply. Issuance cannot take the total supply above it.
    function setRegisteredSupply(uint256 amount, bytes32 reason) external onlyRole(REGISTRAR_ROLE) {
        uint256 supply = totalSupply();
        if (amount < supply) revert RegisteredSupplyBelowTotalSupply(amount, supply);
        TokenStorage storage $ = _getStorage();
        emit RegisteredSupplySet($.registeredSupply, amount, msg.sender, reason);
        $.registeredSupply = amount;
    }

    // ───────── Enforcement ─────────

    /// @notice Freezes or unfreezes an account entirely.
    function setAddressFrozen(address account, bool freeze, bytes32 reason) external onlyRole(ENFORCER_ROLE) {
        _getStorage().frozen[account] = freeze;
        emit AddressFrozen(account, freeze, msg.sender, reason);
    }

    /// @notice Freezes `amount` of the free balance of `account`.
    function freezePartialTokens(address account, uint256 amount, bytes32 reason) external onlyRole(ENFORCER_ROLE) {
        uint256 free = freeBalanceOf(account);
        if (amount > free) revert InsufficientFreeBalance(account, free, amount);
        _getStorage().frozenTokens[account] += amount;
        emit TokensFrozen(account, amount, msg.sender, reason);
    }

    /// @notice Releases `amount` of the frozen balance of `account`.
    function unfreezePartialTokens(address account, uint256 amount, bytes32 reason) external onlyRole(ENFORCER_ROLE) {
        TokenStorage storage $ = _getStorage();
        uint256 frozenAmount = $.frozenTokens[account];
        if (amount > frozenAmount) revert InsufficientFrozenBalance(account, frozenAmount, amount);
        $.frozenTokens[account] = frozenAmount - amount;
        emit TokensUnfrozen(account, amount, msg.sender, reason);
    }

    /// @notice Moves tokens without the holder's consent, for example under a court order.
    /// @dev Skips pause, freeze and compliance checks, but the receiver must be a verified
    ///      investor. Frozen tokens are released only as far as needed to cover `amount`.
    function forcedTransfer(address from, address to, uint256 amount, bytes32 reason) external onlyRole(ENFORCER_ROLE) {
        TokenStorage storage $ = _getStorage();
        if (!$.identityRegistry.isVerified(to)) revert NotVerified(to);
        uint256 balance = balanceOf(from);
        if (amount > balance) revert ERC20InsufficientBalance(from, balance, amount);
        uint256 free = balance - $.frozenTokens[from];
        if (amount > free) {
            uint256 released = amount - free;
            $.frozenTokens[from] -= released;
            emit TokensUnfrozen(from, released, msg.sender, reason);
        }
        _move(from, to, amount);
        emit ForcedTransfer(from, to, amount, msg.sender, reason);
    }

    /// @notice Moves the whole position of a lost wallet to another wallet of the same investor.
    /// @dev The balance, frozen amount and frozen flag move together, and the lost wallet's
    ///      freeze state is cleared.
    function recoveryAddress(address lostWallet, address newWallet, bytes32 reason) external onlyRole(ENFORCER_ROLE) {
        if (lostWallet == newWallet) revert SameWallet();
        TokenStorage storage $ = _getStorage();
        IIdentityRegistry registry = $.identityRegistry;
        if (!registry.isVerified(newWallet)) revert NotVerified(newWallet);
        bytes32 investorId = registry.investorOf(lostWallet);
        if (investorId == bytes32(0) || investorId != registry.investorOf(newWallet)) {
            revert InvestorMismatch(lostWallet, newWallet);
        }

        uint256 amount = balanceOf(lostWallet);
        uint256 frozenAmount = $.frozenTokens[lostWallet];
        if (frozenAmount != 0) {
            $.frozenTokens[lostWallet] = 0;
            $.frozenTokens[newWallet] += frozenAmount;
        }
        if ($.frozen[lostWallet]) {
            $.frozen[lostWallet] = false;
            $.frozen[newWallet] = true;
        }
        _move(lostWallet, newWallet, amount);
        emit RecoverySuccess(lostWallet, newWallet, investorId, amount, msg.sender, reason);
    }

    /// @notice Stops transfers, issuance and cancellation. Enforcement actions stay available.
    function pause(bytes32 reason) external onlyRole(PAUSER_ROLE) {
        _pause();
        emit PauseStateChanged(true, msg.sender, reason);
    }

    /// @notice Resumes ordinary movements.
    function unpause(bytes32 reason) external onlyRole(PAUSER_ROLE) {
        _unpause();
        emit PauseStateChanged(false, msg.sender, reason);
    }

    // ───────── Configuration ─────────

    /// @notice Replaces the compliance contract.
    /// @dev Safe at any time: compliance holds no holdings data.
    function setCompliance(ICompliance compliance_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(compliance_) == address(0)) revert ZeroAddress();
        TokenStorage storage $ = _getStorage();
        emit ComplianceSet(address($.compliance), address(compliance_), msg.sender);
        $.compliance = compliance_;
    }

    // ───────── Views ─────────

    /// @inheritdoc ISecurityToken
    function identityRegistry() external view returns (IIdentityRegistry) {
        return _getStorage().identityRegistry;
    }

    /// @notice Compliance contract consulted on every transfer and mint.
    function compliance() external view returns (ICompliance) {
        return _getStorage().compliance;
    }

    /// @notice Ceiling for the total supply.
    function registeredSupply() external view returns (uint256) {
        return _getStorage().registeredSupply;
    }

    /// @inheritdoc ISecurityToken
    function holderCount() external view returns (uint256) {
        return _getStorage().holderCount;
    }

    /// @inheritdoc ISecurityToken
    function investorBalanceOf(bytes32 investorId) external view returns (uint256) {
        return _getStorage().investorBalance[investorId];
    }

    /// @inheritdoc ISecurityToken
    function isFrozen(address account) external view returns (bool) {
        return _getStorage().frozen[account];
    }

    /// @inheritdoc ISecurityToken
    function getFrozenTokens(address account) external view returns (uint256) {
        return _getStorage().frozenTokens[account];
    }

    /// @inheritdoc ISecurityToken
    function freeBalanceOf(address account) public view returns (uint256) {
        return balanceOf(account) - _getStorage().frozenTokens[account];
    }

    /// @inheritdoc ISecurityToken
    function balanceOfAt(address account, uint256 blockNumber) external view returns (uint256) {
        return _getStorage().balanceCheckpoints[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    /// @inheritdoc ISecurityToken
    function totalSupplyAt(uint256 blockNumber) external view returns (uint256) {
        return _getStorage().supplyCheckpoints.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    // ───────── Internals ─────────

    /// @dev Single validation path for transfers, mints and burns.
    function _update(address from, address to, uint256 value) internal override {
        _requireNotPaused();
        TokenStorage storage $ = _getStorage();

        if (to != address(0)) {
            if (!$.identityRegistry.isVerified(to)) revert NotVerified(to);
            if ($.frozen[to]) revert AccountFrozen(to);
        }
        if (from != address(0)) {
            if (to != address(0) && !$.identityRegistry.isVerified(from)) revert NotVerified(from);
            if ($.frozen[from]) revert AccountFrozen(from);
            uint256 free = freeBalanceOf(from);
            if (value > free) revert InsufficientFreeBalance(from, free, value);
        }
        if (to != address(0)) {
            if (!$.compliance.canTransfer(address(this), from, to, value)) revert ComplianceRejected(from, to, value);
            if (from == address(0)) {
                uint256 supply = totalSupply() + value;
                if (supply > $.registeredSupply) revert RegisteredSupplyExceeded(supply, $.registeredSupply);
            }
        }

        super._update(from, to, value);
        _afterMove(from, to, value);
    }

    /// @dev Moves a balance without validation. Used by forced transfers and wallet recovery.
    function _move(address from, address to, uint256 value) private {
        super._update(from, to, value);
        _afterMove(from, to, value);
    }

    /// @dev Records checkpoints and keeps per-investor balances and the holder count in sync.
    function _afterMove(address from, address to, uint256 value) private {
        TokenStorage storage $ = _getStorage();
        uint48 key = SafeCast.toUint48(block.number);
        bytes32 sender;
        bytes32 receiver;

        if (from != address(0)) {
            $.balanceCheckpoints[from].push(key, SafeCast.toUint208(balanceOf(from)));
            sender = $.identityRegistry.investorOf(from);
        }
        if (to != address(0)) {
            $.balanceCheckpoints[to].push(key, SafeCast.toUint208(balanceOf(to)));
            receiver = $.identityRegistry.investorOf(to);
        }
        if (from == address(0) || to == address(0)) {
            $.supplyCheckpoints.push(key, SafeCast.toUint208(totalSupply()));
        }

        // Movements between wallets of one investor, and zero-value movements, leave the
        // aggregates untouched.
        if (value == 0 || sender == receiver) return;
        if (from != address(0)) {
            uint256 remaining = $.investorBalance[sender] - value;
            $.investorBalance[sender] = remaining;
            if (remaining == 0) $.holderCount--;
        }
        if (to != address(0)) {
            uint256 previous = $.investorBalance[receiver];
            if (previous == 0) $.holderCount++;
            $.investorBalance[receiver] = previous + value;
        }
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _getStorage() private pure returns (TokenStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}
