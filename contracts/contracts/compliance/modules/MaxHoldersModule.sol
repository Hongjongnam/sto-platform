// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceModule} from "../IComplianceModule.sol";
import {ISecurityToken} from "../../token/ISecurityToken.sol";
import {IIdentityRegistry} from "../../identity/IIdentityRegistry.sol";

/// @title MaxHoldersModule
/// @notice Caps the number of investors that hold the token.
/// @dev Counts investors, not wallets.
contract MaxHoldersModule is IComplianceModule, Ownable2Step {
    uint256 private _maxHolders;

    event MaxHoldersSet(uint256 maxHolders, address indexed operator);

    constructor(address owner_, uint256 maxHolders_) Ownable(owner_) {
        _maxHolders = maxHolders_;
        emit MaxHoldersSet(maxHolders_, msg.sender);
    }

    /// @notice Sets the maximum number of holders.
    function setMaxHolders(uint256 maxHolders_) external onlyOwner {
        _maxHolders = maxHolders_;
        emit MaxHoldersSet(maxHolders_, msg.sender);
    }

    /// @notice Maximum number of holders.
    function maxHolders() external view returns (uint256) {
        return _maxHolders;
    }

    /// @inheritdoc IComplianceModule
    function moduleCheck(address token, address from, address to, uint256 amount) external view returns (bool) {
        if (amount == 0) return true;
        ISecurityToken securityToken = ISecurityToken(token);
        IIdentityRegistry registry = securityToken.identityRegistry();
        // An existing holder receiving more does not add a holder.
        if (securityToken.investorBalanceOf(registry.investorOf(to)) != 0) return true;
        // A holder handing over their entire position is replaced, not added to.
        if (from != address(0) && securityToken.investorBalanceOf(registry.investorOf(from)) == amount) return true;
        return securityToken.holderCount() < _maxHolders;
    }

    /// @inheritdoc IComplianceModule
    function name() external pure returns (string memory) {
        return "MaxHoldersModule";
    }
}
