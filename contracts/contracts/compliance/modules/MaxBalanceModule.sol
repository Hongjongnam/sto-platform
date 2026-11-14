// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceModule} from "../IComplianceModule.sol";
import {ISecurityToken} from "../../token/ISecurityToken.sol";
import {IIdentityRegistry} from "../../identity/IIdentityRegistry.sol";

/// @title MaxBalanceModule
/// @notice Caps how much a single investor may hold, with a separate cap per investor type.
/// @dev The cap applies to the investor's combined balance across all of their wallets.
///      A type with no cap configured cannot receive tokens.
contract MaxBalanceModule is IComplianceModule, Ownable2Step {
    mapping(uint8 investorType => uint256) private _maxBalance;

    event MaxBalanceSet(uint8 indexed investorType, uint256 maxBalance, address indexed operator);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Sets the holding cap for `investorType`.
    function setMaxBalance(uint8 investorType, uint256 maxBalance) external onlyOwner {
        _maxBalance[investorType] = maxBalance;
        emit MaxBalanceSet(investorType, maxBalance, msg.sender);
    }

    /// @notice Holding cap for `investorType`.
    function maxBalanceOf(uint8 investorType) external view returns (uint256) {
        return _maxBalance[investorType];
    }

    /// @inheritdoc IComplianceModule
    function moduleCheck(address token, address from, address to, uint256 amount) external view returns (bool) {
        if (amount == 0) return true;
        IIdentityRegistry registry = ISecurityToken(token).identityRegistry();
        bytes32 receiver = registry.investorOf(to);
        // Moving tokens between wallets of the same investor does not change their holding.
        if (from != address(0) && registry.investorOf(from) == receiver) return true;
        return ISecurityToken(token).investorBalanceOf(receiver) + amount <= _maxBalance[registry.investorTypeOf(to)];
    }

    /// @inheritdoc IComplianceModule
    function name() external pure returns (string memory) {
        return "MaxBalanceModule";
    }
}
