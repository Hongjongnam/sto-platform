// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISecurityToken} from "../token/ISecurityToken.sol";

/// @title RedemptionManager
/// @notice Redeems securities for cash at a fixed price per unit. Cancelling the securities and
///         paying the holder happen in one transaction.
/// @dev Needs the token's `ISSUER_ROLE` to burn. The token refuses to burn frozen tokens or
///      tokens of a frozen account, so redemption cannot be used to escape a freeze.
contract RedemptionManager is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        ISecurityToken token;
        IERC20 cash;
        uint256 pricePerUnit;
        uint256 deposited;
        uint256 paid;
        uint64 deadline;
        bool closed;
    }

    /// @notice Opens and closes redemption rounds.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @notice Reason recorded on the token when units are cancelled through redemption.
    bytes32 public constant REDEMPTION_REASON = "REDEMPTION";

    Round[] private _rounds;

    event RedemptionOpened(
        uint256 indexed id,
        address indexed token,
        address indexed cash,
        uint256 pricePerUnit,
        uint256 deposited,
        uint64 deadline,
        address operator
    );
    event Redeemed(uint256 indexed id, address indexed holder, uint256 quantity, uint256 payout);
    event RedemptionClosed(uint256 indexed id, address indexed to, uint256 returned, address indexed operator);

    error ZeroAddress();
    error ZeroAmount();
    error DeadlineNotInFuture(uint64 deadline);
    error NothingToRedeem();
    error RedemptionWindowClosed(uint256 id);
    error RedemptionWindowOpen(uint256 id);
    error NotEligible(address holder);
    error InsufficientFunds(uint256 id, uint256 available, uint256 needed);
    error AlreadyClosed(uint256 id);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Opens a redemption round funded for the whole outstanding supply.
    /// @dev Pulls `totalSupply * pricePerUnit` of `cash` from the caller.
    function openRedemption(
        ISecurityToken token,
        IERC20 cash,
        uint256 pricePerUnit,
        uint64 deadline
    ) external nonReentrant onlyRole(ISSUER_ROLE) returns (uint256 id) {
        if (address(token) == address(0) || address(cash) == address(0)) revert ZeroAddress();
        if (pricePerUnit == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture(deadline);
        uint256 supply = IERC20(address(token)).totalSupply();
        if (supply == 0) revert NothingToRedeem();

        uint256 deposit = supply * pricePerUnit;
        id = _rounds.length;
        _rounds.push(
            Round({
                token: token,
                cash: cash,
                pricePerUnit: pricePerUnit,
                deposited: deposit,
                paid: 0,
                deadline: deadline,
                closed: false
            })
        );
        emit RedemptionOpened(id, address(token), address(cash), pricePerUnit, deposit, deadline, msg.sender);
        cash.safeTransferFrom(msg.sender, address(this), deposit);
    }

    /// @notice Redeems `quantity` units held by the caller in round `id`.
    /// @dev The caller must be a verified investor. Only free, unfrozen units can be redeemed.
    function redeem(uint256 id, uint256 quantity) external nonReentrant {
        if (quantity == 0) revert ZeroAmount();
        Round storage round = _rounds[id];
        if (block.timestamp > round.deadline) revert RedemptionWindowClosed(id);
        ISecurityToken token = round.token;
        if (!token.identityRegistry().isVerified(msg.sender)) revert NotEligible(msg.sender);

        uint256 payout = quantity * round.pricePerUnit;
        uint256 available = round.deposited - round.paid;
        if (payout > available) revert InsufficientFunds(id, available, payout);

        round.paid += payout;
        emit Redeemed(id, msg.sender, quantity, payout);
        token.burn(msg.sender, quantity, REDEMPTION_REASON);
        round.cash.safeTransfer(msg.sender, payout);
    }

    /// @notice After the deadline, returns the unpaid deposit to `to`.
    function close(uint256 id, address to) external nonReentrant onlyRole(ISSUER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        Round storage round = _rounds[id];
        if (block.timestamp <= round.deadline) revert RedemptionWindowOpen(id);
        if (round.closed) revert AlreadyClosed(id);

        round.closed = true;
        uint256 returned = round.deposited - round.paid;
        emit RedemptionClosed(id, to, returned, msg.sender);
        round.cash.safeTransfer(to, returned);
    }

    /// @notice Stored round `id`.
    function getRound(uint256 id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @notice Number of rounds opened.
    function roundCount() external view returns (uint256) {
        return _rounds.length;
    }
}
