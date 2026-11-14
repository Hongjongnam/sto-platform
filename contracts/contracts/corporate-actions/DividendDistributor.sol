// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISecurityToken} from "../token/ISecurityToken.sol";

/// @title DividendDistributor
/// @notice Pays a cash distribution pro rata to balances at a record block. Holders claim
///         their share (pull), so the cost of a distribution does not grow with the number of
///         holders and one failing payment cannot block the others.
contract DividendDistributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Distribution {
        ISecurityToken token;
        IERC20 cash;
        uint256 recordBlock;
        uint256 totalAmount;
        uint256 claimedAmount;
        uint64 claimDeadline;
        bool swept;
    }

    /// @notice Creates distributions and sweeps what is left after the deadline.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    Distribution[] private _distributions;
    mapping(uint256 id => mapping(address holder => bool)) private _claimed;

    event DistributionCreated(
        uint256 indexed id,
        address indexed token,
        address indexed cash,
        uint256 recordBlock,
        uint64 recordDate,
        uint256 totalAmount,
        uint64 claimDeadline,
        address operator
    );
    event DividendClaimed(uint256 indexed id, address indexed holder, uint256 amount);
    event DistributionSwept(uint256 indexed id, address indexed to, uint256 amount, address indexed operator);

    error ZeroAddress();
    error ZeroAmount();
    error RecordBlockNotPast(uint256 recordBlock);
    error DeadlineNotInFuture(uint64 claimDeadline);
    error NoSupplyAtRecordBlock(uint256 recordBlock);
    error ClaimWindowClosed(uint256 id);
    error ClaimWindowOpen(uint256 id);
    error AlreadyClaimed(uint256 id, address holder);
    error NotEligible(address holder);
    error NothingToClaim(uint256 id, address holder);
    error AlreadySwept(uint256 id);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Funds a distribution from the caller and opens it for claims.
    /// @param token Security token whose holders are paid.
    /// @param cash Token the distribution is paid in.
    /// @param recordBlock Past block whose closing balances determine the shares.
    /// @param recordDate Calendar record date as a Unix timestamp; informational, emitted only.
    /// @param totalAmount Cash to distribute, pulled from the caller.
    /// @param claimDeadline Last moment a holder can claim.
    function createDistribution(
        ISecurityToken token,
        IERC20 cash,
        uint256 recordBlock,
        uint64 recordDate,
        uint256 totalAmount,
        uint64 claimDeadline
    ) external nonReentrant onlyRole(ISSUER_ROLE) returns (uint256 id) {
        if (address(token) == address(0) || address(cash) == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert ZeroAmount();
        if (recordBlock >= block.number) revert RecordBlockNotPast(recordBlock);
        if (claimDeadline <= block.timestamp) revert DeadlineNotInFuture(claimDeadline);
        if (token.totalSupplyAt(recordBlock) == 0) revert NoSupplyAtRecordBlock(recordBlock);

        id = _distributions.length;
        _distributions.push(
            Distribution({
                token: token,
                cash: cash,
                recordBlock: recordBlock,
                totalAmount: totalAmount,
                claimedAmount: 0,
                claimDeadline: claimDeadline,
                swept: false
            })
        );
        emit DistributionCreated(
            id,
            address(token),
            address(cash),
            recordBlock,
            recordDate,
            totalAmount,
            claimDeadline,
            msg.sender
        );
        cash.safeTransferFrom(msg.sender, address(this), totalAmount);
    }

    /// @notice Claims the caller's share of distribution `id`.
    /// @dev The caller must be a verified investor whose account is not frozen at claim time.
    function claim(uint256 id) external nonReentrant {
        Distribution storage distribution = _distributions[id];
        if (block.timestamp > distribution.claimDeadline) revert ClaimWindowClosed(id);
        if (_claimed[id][msg.sender]) revert AlreadyClaimed(id, msg.sender);
        ISecurityToken token = distribution.token;
        if (!token.identityRegistry().isVerified(msg.sender) || token.isFrozen(msg.sender)) {
            revert NotEligible(msg.sender);
        }
        uint256 amount = _share(distribution, msg.sender);
        if (amount == 0) revert NothingToClaim(id, msg.sender);

        _claimed[id][msg.sender] = true;
        distribution.claimedAmount += amount;
        emit DividendClaimed(id, msg.sender, amount);
        distribution.cash.safeTransfer(msg.sender, amount);
    }

    /// @notice After the deadline, sends unclaimed cash and rounding remainders to `to`.
    function sweep(uint256 id, address to) external nonReentrant onlyRole(ISSUER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        Distribution storage distribution = _distributions[id];
        if (block.timestamp <= distribution.claimDeadline) revert ClaimWindowOpen(id);
        if (distribution.swept) revert AlreadySwept(id);

        distribution.swept = true;
        uint256 amount = distribution.totalAmount - distribution.claimedAmount;
        emit DistributionSwept(id, to, amount, msg.sender);
        distribution.cash.safeTransfer(to, amount);
    }

    /// @notice Amount `holder` can still claim from distribution `id`, ignoring eligibility.
    function claimable(uint256 id, address holder) external view returns (uint256) {
        if (_claimed[id][holder]) return 0;
        return _share(_distributions[id], holder);
    }

    /// @notice Whether `holder` has claimed distribution `id`.
    function hasClaimed(uint256 id, address holder) external view returns (bool) {
        return _claimed[id][holder];
    }

    /// @notice Stored distribution `id`.
    function getDistribution(uint256 id) external view returns (Distribution memory) {
        return _distributions[id];
    }

    /// @notice Number of distributions created.
    function distributionCount() external view returns (uint256) {
        return _distributions.length;
    }

    /// @dev Rounds down; the remainder stays in the contract until swept.
    function _share(Distribution storage distribution, address holder) private view returns (uint256) {
        return
            Math.mulDiv(
                distribution.totalAmount,
                distribution.token.balanceOfAt(holder, distribution.recordBlock),
                distribution.token.totalSupplyAt(distribution.recordBlock)
            );
    }
}
