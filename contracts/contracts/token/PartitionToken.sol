// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIdentityRegistry} from "../identity/IIdentityRegistry.sol";

/// @title PartitionToken
/// @notice Security token following the ERC-1400 family: balances are split into partitions
///         (ERC-1410), transfers can be validated in advance with a reason code (ERC-1594,
///         ERC-1066), controllers can force transfers and redemptions (ERC-1644) and offering
///         documents are anchored on-chain (ERC-1643).
/// @dev Where SecurityToken (ERC-3643) centres on who may hold the token, this contract centres
///      on what kind of holding a balance is: a partition can be locked up and later converted
///      into another. Both tokens resolve investors through the same identity registry.
///      There is no ERC-20 `transfer`; every movement names its partition.
contract PartitionToken is AccessControl, Pausable {
    struct Document {
        string uri;
        bytes32 documentHash;
        uint256 timestamp;
    }

    /// @notice Issues, redeems, manages lock-ups, conversions and documents.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    /// @notice Forces transfers and redemptions and freezes accounts.
    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");
    /// @notice Pauses and unpauses holder-initiated transfers.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant DEFAULT_PARTITION = "GENERAL";
    bytes32 public constant LOCKUP_PARTITION = "LOCKUP";

    // ERC-1066 status codes used by ERC-1400.
    bytes1 public constant STATUS_TRANSFER_SUCCESS = 0x51;
    bytes1 public constant STATUS_INSUFFICIENT_BALANCE = 0x52;
    bytes1 public constant STATUS_TRANSFERS_HALTED = 0x54;
    bytes1 public constant STATUS_FUNDS_LOCKED = 0x55;
    bytes1 public constant STATUS_INVALID_SENDER = 0x56;
    bytes1 public constant STATUS_INVALID_RECEIVER = 0x57;
    bytes1 public constant STATUS_INVALID_OPERATOR = 0x58;

    string public name;
    string public symbol;
    IIdentityRegistry public immutable identityRegistry;

    uint256 public totalSupply;
    bool private _issuable = true;

    mapping(address holder => uint256) private _balances;
    mapping(address holder => mapping(bytes32 partition => uint256)) private _partitionBalances;
    mapping(bytes32 partition => uint256) private _partitionSupply;
    mapping(address holder => bytes32[]) private _partitionsOf;
    mapping(address holder => mapping(bytes32 partition => uint256)) private _partitionIndex; // index + 1

    mapping(address holder => mapping(address operator => bool)) private _operators;
    mapping(address account => bool) private _frozen;
    mapping(bytes32 partition => uint64) private _lockedUntil;
    mapping(bytes32 partition => bytes32) private _conversionTarget;

    mapping(bytes32 documentName => Document) private _documents;
    bytes32[] private _documentNames;
    mapping(bytes32 documentName => uint256) private _documentIndex; // index + 1

    // ERC-1410
    event TransferByPartition(
        bytes32 indexed fromPartition,
        address operator,
        address indexed from,
        address indexed to,
        uint256 value,
        bytes data,
        bytes operatorData
    );
    event IssuedByPartition(bytes32 indexed partition, address indexed operator, address indexed to, uint256 value, bytes data);
    event RedeemedByPartition(
        bytes32 indexed partition,
        address indexed operator,
        address indexed from,
        uint256 value,
        bytes operatorData
    );
    event AuthorizedOperator(address indexed operator, address indexed tokenHolder);
    event RevokedOperator(address indexed operator, address indexed tokenHolder);
    // ERC-1644
    event ControllerTransfer(
        address controller,
        address indexed from,
        address indexed to,
        uint256 value,
        bytes data,
        bytes operatorData
    );
    event ControllerRedemption(address controller, address indexed tokenHolder, uint256 value, bytes data, bytes operatorData);
    // ERC-1643
    event DocumentUpdated(bytes32 indexed name, string uri, bytes32 documentHash);
    event DocumentRemoved(bytes32 indexed name, string uri, bytes32 documentHash);

    event PartitionConverted(bytes32 indexed fromPartition, bytes32 indexed toPartition, address indexed holder, uint256 value);
    event LockupSet(bytes32 indexed partition, uint64 lockedUntil, address indexed operator);
    event ConversionSet(bytes32 indexed fromPartition, bytes32 indexed toPartition, address indexed operator);
    event AddressFrozen(address indexed account, bool frozen, address indexed operator, bytes32 reason);
    event IssuanceClosed(address indexed operator);

    error ZeroAddress();
    error TransferRejected(bytes1 code, bytes32 reason);
    error IssuanceIsClosed();
    error InsufficientPartitionBalance(address holder, bytes32 partition, uint256 balance, uint256 needed);
    error NoConversionConfigured(bytes32 partition);
    error PartitionLocked(bytes32 partition, uint64 lockedUntil);
    error DocumentNotFound(bytes32 name);
    error InvalidDocument();

    constructor(string memory name_, string memory symbol_, address admin, IIdentityRegistry registry) {
        if (admin == address(0) || address(registry) == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        identityRegistry = registry;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Securities are whole units.
    function decimals() external pure returns (uint8) {
        return 0;
    }

    // ───────── ERC-1410: balances ─────────

    /// @notice Balance of `holder` across all partitions.
    function balanceOf(address holder) external view returns (uint256) {
        return _balances[holder];
    }

    /// @notice Balance of `holder` in `partition`.
    function balanceOfByPartition(bytes32 partition, address holder) external view returns (uint256) {
        return _partitionBalances[holder][partition];
    }

    /// @notice Total supply held in `partition`.
    function totalSupplyByPartition(bytes32 partition) external view returns (uint256) {
        return _partitionSupply[partition];
    }

    /// @notice Partitions in which `holder` has a balance.
    function partitionsOf(address holder) external view returns (bytes32[] memory) {
        return _partitionsOf[holder];
    }

    // ───────── ERC-1410 / ERC-1594: transfers ─────────

    /// @notice Checks whether `operator` could move `value` of `partition` from `from` to `to`.
    /// @return code ERC-1066 status code; 0x51 means the transfer would succeed.
    /// @return reason Short machine-readable reason, empty on success.
    /// @return destinationPartition Partition the receiver would be credited in.
    function canTransferByPartition(
        address operator,
        address from,
        address to,
        bytes32 partition,
        uint256 value
    ) public view returns (bytes1 code, bytes32 reason, bytes32 destinationPartition) {
        if (paused()) return (STATUS_TRANSFERS_HALTED, "PAUSED", bytes32(0));
        if (operator != from && !_operators[from][operator]) {
            return (STATUS_INVALID_OPERATOR, "OPERATOR_NOT_AUTHORIZED", bytes32(0));
        }
        if (_frozen[from]) return (STATUS_INVALID_SENDER, "SENDER_FROZEN", bytes32(0));
        if (!identityRegistry.isVerified(from)) return (STATUS_INVALID_SENDER, "SENDER_NOT_VERIFIED", bytes32(0));
        if (to == address(0) || !identityRegistry.isVerified(to)) {
            return (STATUS_INVALID_RECEIVER, "RECEIVER_NOT_VERIFIED", bytes32(0));
        }
        if (_frozen[to]) return (STATUS_INVALID_RECEIVER, "RECEIVER_FROZEN", bytes32(0));
        if (block.timestamp < _lockedUntil[partition]) return (STATUS_FUNDS_LOCKED, "PARTITION_LOCKED", bytes32(0));
        if (_partitionBalances[from][partition] < value) {
            return (STATUS_INSUFFICIENT_BALANCE, "INSUFFICIENT_BALANCE", bytes32(0));
        }
        return (STATUS_TRANSFER_SUCCESS, bytes32(0), partition);
    }

    /// @notice Moves `value` of the caller's `partition` balance to `to`.
    function transferByPartition(
        bytes32 partition,
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bytes32) {
        return _transferChecked(partition, msg.sender, to, value, data, "");
    }

    /// @notice Moves `value` of `from`'s `partition` balance to `to` as an authorised operator.
    function operatorTransferByPartition(
        bytes32 partition,
        address from,
        address to,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external returns (bytes32) {
        return _transferChecked(partition, from, to, value, data, operatorData);
    }

    /// @notice Authorises `operator` to move the caller's balances.
    function authorizeOperator(address operator) external {
        _operators[msg.sender][operator] = true;
        emit AuthorizedOperator(operator, msg.sender);
    }

    /// @notice Withdraws the authorisation of `operator`.
    function revokeOperator(address operator) external {
        _operators[msg.sender][operator] = false;
        emit RevokedOperator(operator, msg.sender);
    }

    /// @notice Whether `operator` may move `holder`'s balances.
    function isOperator(address operator, address holder) external view returns (bool) {
        return operator == holder || _operators[holder][operator];
    }

    // ───────── ERC-1594: issuance and redemption ─────────

    /// @notice Whether new units can still be issued.
    function isIssuable() external view returns (bool) {
        return _issuable;
    }

    /// @notice Permanently ends issuance.
    function closeIssuance() external onlyRole(ISSUER_ROLE) {
        _issuable = false;
        emit IssuanceClosed(msg.sender);
    }

    /// @notice Issues `value` to `to` in `partition`. The receiver must be a verified investor.
    function issueByPartition(bytes32 partition, address to, uint256 value, bytes calldata data) external onlyRole(ISSUER_ROLE) {
        if (!_issuable) revert IssuanceIsClosed();
        if (to == address(0) || !identityRegistry.isVerified(to)) {
            revert TransferRejected(STATUS_INVALID_RECEIVER, "RECEIVER_NOT_VERIFIED");
        }
        if (_frozen[to]) revert TransferRejected(STATUS_INVALID_RECEIVER, "RECEIVER_FROZEN");
        totalSupply += value;
        _partitionSupply[partition] += value;
        _credit(partition, to, value);
        emit IssuedByPartition(partition, msg.sender, to, value, data);
    }

    /// @notice Redeems `value` of `from`'s `partition` balance. Locked partitions and frozen
    ///         accounts cannot be redeemed this way.
    function redeemByPartition(bytes32 partition, address from, uint256 value, bytes calldata data) external onlyRole(ISSUER_ROLE) {
        if (_frozen[from]) revert TransferRejected(STATUS_INVALID_SENDER, "SENDER_FROZEN");
        if (block.timestamp < _lockedUntil[partition]) revert TransferRejected(STATUS_FUNDS_LOCKED, "PARTITION_LOCKED");
        _burn(partition, from, value);
        emit RedeemedByPartition(partition, msg.sender, from, value, data);
    }

    // ───────── ERC-1644: controller operations ─────────

    /// @notice Controllers can always act on this token.
    function isControllable() external pure returns (bool) {
        return true;
    }

    /// @notice Forces a transfer, for example under a court order.
    /// @dev Skips pause, freeze, lock-up and operator checks; the receiver must be verified.
    function controllerTransferByPartition(
        bytes32 partition,
        address from,
        address to,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external onlyRole(CONTROLLER_ROLE) {
        if (to == address(0) || !identityRegistry.isVerified(to)) {
            revert TransferRejected(STATUS_INVALID_RECEIVER, "RECEIVER_NOT_VERIFIED");
        }
        _debit(partition, from, value);
        _credit(partition, to, value);
        emit TransferByPartition(partition, msg.sender, from, to, value, data, operatorData);
        emit ControllerTransfer(msg.sender, from, to, value, data, operatorData);
    }

    /// @notice Forces a redemption. Skips freeze and lock-up checks.
    function controllerRedeemByPartition(
        bytes32 partition,
        address from,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external onlyRole(CONTROLLER_ROLE) {
        _burn(partition, from, value);
        emit RedeemedByPartition(partition, msg.sender, from, value, operatorData);
        emit ControllerRedemption(msg.sender, from, value, data, operatorData);
    }

    /// @notice Freezes or unfreezes an account.
    function setAddressFrozen(address account, bool freeze, bytes32 reason) external onlyRole(CONTROLLER_ROLE) {
        _frozen[account] = freeze;
        emit AddressFrozen(account, freeze, msg.sender, reason);
    }

    /// @notice Whether `account` is frozen.
    function isFrozen(address account) external view returns (bool) {
        return _frozen[account];
    }

    // ───────── Lock-up and conversion ─────────

    /// @notice Locks `partition` until `lockedUntil`. Pass zero to remove the lock.
    function setLockup(bytes32 partition, uint64 lockedUntil_) external onlyRole(ISSUER_ROLE) {
        _lockedUntil[partition] = lockedUntil_;
        emit LockupSet(partition, lockedUntil_, msg.sender);
    }

    /// @notice Time until which `partition` cannot be transferred, redeemed or converted.
    function lockedUntil(bytes32 partition) external view returns (uint64) {
        return _lockedUntil[partition];
    }

    /// @notice Lets holders convert `fromPartition` balances into `toPartition`. Pass zero to disable.
    function setConversion(bytes32 fromPartition, bytes32 toPartition) external onlyRole(ISSUER_ROLE) {
        _conversionTarget[fromPartition] = toPartition;
        emit ConversionSet(fromPartition, toPartition, msg.sender);
    }

    /// @notice Partition that `partition` balances can be converted into, or zero.
    function conversionTarget(bytes32 partition) external view returns (bytes32) {
        return _conversionTarget[partition];
    }

    /// @notice Converts `value` of the caller's `fromPartition` balance into the configured
    ///         target partition, for example locked units into freely transferable ones once
    ///         the lock-up has ended.
    function convertPartition(bytes32 fromPartition, uint256 value) external whenNotPaused {
        bytes32 toPartition = _conversionTarget[fromPartition];
        if (toPartition == bytes32(0)) revert NoConversionConfigured(fromPartition);
        uint64 locked = _lockedUntil[fromPartition];
        if (block.timestamp < locked) revert PartitionLocked(fromPartition, locked);
        if (_frozen[msg.sender]) revert TransferRejected(STATUS_INVALID_SENDER, "SENDER_FROZEN");

        _debit(fromPartition, msg.sender, value);
        _credit(toPartition, msg.sender, value);
        _partitionSupply[fromPartition] -= value;
        _partitionSupply[toPartition] += value;
        emit PartitionConverted(fromPartition, toPartition, msg.sender, value);
    }

    // ───────── Pause ─────────

    /// @notice Stops holder- and operator-initiated transfers and conversions.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes transfers and conversions.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ───────── ERC-1643: documents ─────────

    /// @notice Attaches or updates a document, such as a prospectus, by name.
    function setDocument(bytes32 documentName, string calldata uri, bytes32 documentHash) external onlyRole(ISSUER_ROLE) {
        if (documentName == bytes32(0) || bytes(uri).length == 0) revert InvalidDocument();
        if (_documentIndex[documentName] == 0) {
            _documentNames.push(documentName);
            _documentIndex[documentName] = _documentNames.length;
        }
        _documents[documentName] = Document(uri, documentHash, block.timestamp);
        emit DocumentUpdated(documentName, uri, documentHash);
    }

    /// @notice Removes a document.
    function removeDocument(bytes32 documentName) external onlyRole(ISSUER_ROLE) {
        uint256 index = _documentIndex[documentName];
        if (index == 0) revert DocumentNotFound(documentName);
        Document memory document = _documents[documentName];

        bytes32 last = _documentNames[_documentNames.length - 1];
        _documentNames[index - 1] = last;
        _documentIndex[last] = index;
        _documentNames.pop();
        delete _documentIndex[documentName];
        delete _documents[documentName];
        emit DocumentRemoved(documentName, document.uri, document.documentHash);
    }

    /// @notice URI, hash and last-modified time of a document.
    function getDocument(bytes32 documentName) external view returns (string memory, bytes32, uint256) {
        Document storage document = _documents[documentName];
        return (document.uri, document.documentHash, document.timestamp);
    }

    /// @notice Names of all attached documents.
    function getAllDocuments() external view returns (bytes32[] memory) {
        return _documentNames;
    }

    // ───────── Internals ─────────

    function _transferChecked(
        bytes32 partition,
        address from,
        address to,
        uint256 value,
        bytes calldata data,
        bytes memory operatorData
    ) private returns (bytes32) {
        (bytes1 code, bytes32 reason, ) = canTransferByPartition(msg.sender, from, to, partition, value);
        if (code != STATUS_TRANSFER_SUCCESS) revert TransferRejected(code, reason);
        _debit(partition, from, value);
        _credit(partition, to, value);
        emit TransferByPartition(partition, msg.sender, from, to, value, data, operatorData);
        return partition;
    }

    function _burn(bytes32 partition, address from, uint256 value) private {
        _debit(partition, from, value);
        totalSupply -= value;
        _partitionSupply[partition] -= value;
    }

    function _debit(bytes32 partition, address holder, uint256 value) private {
        uint256 balance = _partitionBalances[holder][partition];
        if (balance < value) revert InsufficientPartitionBalance(holder, partition, balance, value);
        if (value == 0) return;
        uint256 remaining = balance - value;
        _partitionBalances[holder][partition] = remaining;
        _balances[holder] -= value;

        if (remaining == 0) {
            bytes32[] storage partitions = _partitionsOf[holder];
            uint256 index = _partitionIndex[holder][partition];
            bytes32 last = partitions[partitions.length - 1];
            partitions[index - 1] = last;
            _partitionIndex[holder][last] = index;
            partitions.pop();
            delete _partitionIndex[holder][partition];
        }
    }

    function _credit(bytes32 partition, address holder, uint256 value) private {
        if (value == 0) return;
        if (_partitionBalances[holder][partition] == 0) {
            _partitionsOf[holder].push(partition);
            _partitionIndex[holder][partition] = _partitionsOf[holder].length;
        }
        _partitionBalances[holder][partition] += value;
        _balances[holder] += value;
    }
}
