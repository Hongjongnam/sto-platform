// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DvPSettlement
/// @notice Delivery-versus-payment: the security leg and the cash leg of a trade settle in one
///         transaction or not at all.
/// @dev A trade is registered under the hash of its off-chain trade number, so a trade can be
///      settled at most once. Both parties sign the exact terms; an allowance alone would prove
///      consent to deliver but not to the price. The security token re-checks identity and
///      compliance inside `transferFrom`, and a failure there reverts the whole settlement.
contract DvPSettlement is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Settled,
        Cancelled
    }

    struct Trade {
        address seller;
        address buyer;
        IERC20 security;
        IERC20 cash;
        uint256 quantity;
        uint256 price;
        uint64 expiry;
        Status status;
    }

    /// @notice Terms signed by both parties.
    struct TradeTerms {
        bytes32 tradeId;
        address seller;
        address buyer;
        IERC20 security;
        IERC20 cash;
        uint256 quantity;
        uint256 price;
        uint64 expiry;
    }

    /// @notice Registers, settles and cancels trades.
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    bytes32 public constant TRADE_TYPEHASH =
        keccak256(
            "Trade(bytes32 tradeId,address seller,address buyer,address security,address cash,uint256 quantity,uint256 price,uint64 expiry)"
        );

    mapping(bytes32 tradeId => Trade) private _trades;
    mapping(address token => bool) private _securityAllowed;
    mapping(address token => bool) private _cashAllowed;

    event SecurityAllowed(address indexed token, bool allowed, address indexed operator);
    event CashAllowed(address indexed token, bool allowed, address indexed operator);
    event TradeCreated(
        bytes32 indexed tradeId,
        address indexed seller,
        address indexed buyer,
        address security,
        address cash,
        uint256 quantity,
        uint256 price,
        uint64 expiry,
        address operator
    );
    event TradeSettled(bytes32 indexed tradeId, address indexed operator);
    event TradeCancelled(bytes32 indexed tradeId, address indexed operator, bytes32 reason);

    error ZeroAddress();
    error TradeExists(bytes32 tradeId);
    error InvalidStatus(bytes32 tradeId, Status status);
    error TradeExpired(bytes32 tradeId, uint64 expiry);
    error TokenNotAllowed(address token);
    error InvalidTerms();
    error InvalidSignature(address signer);

    constructor(address admin) EIP712("DvPSettlement", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Allows or disallows a token as the security leg.
    function setSecurityAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        _securityAllowed[token] = allowed;
        emit SecurityAllowed(token, allowed, msg.sender);
    }

    /// @notice Allows or disallows a token as the cash leg.
    function setCashAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        _cashAllowed[token] = allowed;
        emit CashAllowed(token, allowed, msg.sender);
    }

    /// @notice Registers a trade whose terms both parties have signed.
    /// @param terms Trade terms; `tradeId` is the hash of the off-chain trade number.
    /// @param sellerSignature Seller's signature over the `Trade` typed data.
    /// @param buyerSignature Buyer's signature over the `Trade` typed data.
    function createTrade(
        TradeTerms calldata terms,
        bytes calldata sellerSignature,
        bytes calldata buyerSignature
    ) external onlyRole(SETTLEMENT_ROLE) {
        if (_trades[terms.tradeId].status != Status.None) revert TradeExists(terms.tradeId);
        if (!_securityAllowed[address(terms.security)]) revert TokenNotAllowed(address(terms.security));
        if (!_cashAllowed[address(terms.cash)]) revert TokenNotAllowed(address(terms.cash));
        if (terms.seller == address(0) || terms.buyer == address(0) || terms.seller == terms.buyer) {
            revert InvalidTerms();
        }
        if (terms.quantity == 0) revert InvalidTerms();
        if (terms.expiry <= block.timestamp) revert TradeExpired(terms.tradeId, terms.expiry);

        bytes32 digest = _hashTypedDataV4(_hashTerms(terms));
        if (!SignatureChecker.isValidSignatureNow(terms.seller, digest, sellerSignature)) {
            revert InvalidSignature(terms.seller);
        }
        if (!SignatureChecker.isValidSignatureNow(terms.buyer, digest, buyerSignature)) {
            revert InvalidSignature(terms.buyer);
        }

        _trades[terms.tradeId] = Trade({
            seller: terms.seller,
            buyer: terms.buyer,
            security: terms.security,
            cash: terms.cash,
            quantity: terms.quantity,
            price: terms.price,
            expiry: terms.expiry,
            status: Status.Pending
        });
        _emitCreated(terms);
    }

    /// @notice Settles a pending trade: securities to the buyer, cash to the seller.
    /// @dev Both parties must have approved this contract for their leg. If either transfer
    ///      fails the transaction reverts and the trade stays pending.
    function settle(bytes32 tradeId) external nonReentrant onlyRole(SETTLEMENT_ROLE) {
        Trade storage trade = _trades[tradeId];
        if (trade.status != Status.Pending) revert InvalidStatus(tradeId, trade.status);
        if (block.timestamp > trade.expiry) revert TradeExpired(tradeId, trade.expiry);

        trade.status = Status.Settled;
        // Pulling from the parties is intended: both signed these exact terms when the trade
        // was registered, and each approved this contract for their own leg.
        // slither-disable-next-line arbitrary-send-erc20
        trade.security.safeTransferFrom(trade.seller, trade.buyer, trade.quantity);
        // slither-disable-next-line arbitrary-send-erc20
        trade.cash.safeTransferFrom(trade.buyer, trade.seller, trade.price);
        emit TradeSettled(tradeId, msg.sender);
    }

    /// @notice Cancels a pending trade.
    function cancel(bytes32 tradeId, bytes32 reason) external onlyRole(SETTLEMENT_ROLE) {
        Trade storage trade = _trades[tradeId];
        if (trade.status != Status.Pending) revert InvalidStatus(tradeId, trade.status);
        trade.status = Status.Cancelled;
        emit TradeCancelled(tradeId, msg.sender, reason);
    }

    /// @notice Stored trade for `tradeId`.
    function getTrade(bytes32 tradeId) external view returns (Trade memory) {
        return _trades[tradeId];
    }

    /// @notice Whether `token` may be used as the security leg.
    function isSecurityAllowed(address token) external view returns (bool) {
        return _securityAllowed[token];
    }

    /// @notice Whether `token` may be used as the cash leg.
    function isCashAllowed(address token) external view returns (bool) {
        return _cashAllowed[token];
    }

    function _hashTerms(TradeTerms calldata terms) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    TRADE_TYPEHASH,
                    terms.tradeId,
                    terms.seller,
                    terms.buyer,
                    terms.security,
                    terms.cash,
                    terms.quantity,
                    terms.price,
                    terms.expiry
                )
            );
    }

    function _emitCreated(TradeTerms calldata terms) private {
        emit TradeCreated(
            terms.tradeId,
            terms.seller,
            terms.buyer,
            address(terms.security),
            address(terms.cash),
            terms.quantity,
            terms.price,
            terms.expiry,
            msg.sender
        );
    }
}
