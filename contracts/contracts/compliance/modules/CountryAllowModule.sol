// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceModule} from "../IComplianceModule.sol";
import {ISecurityToken} from "../../token/ISecurityToken.sol";

/// @title CountryAllowModule
/// @notice Only lets investors from allowed countries receive the token.
contract CountryAllowModule is IComplianceModule, Ownable2Step {
    mapping(uint16 country => bool) private _allowed;

    event CountryAllowed(uint16 indexed country, bool allowed, address indexed operator);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Allows or disallows an ISO 3166-1 numeric country code.
    function setCountryAllowed(uint16 country, bool allowed) external onlyOwner {
        _allowed[country] = allowed;
        emit CountryAllowed(country, allowed, msg.sender);
    }

    /// @notice Whether `country` may receive the token.
    function isCountryAllowed(uint16 country) external view returns (bool) {
        return _allowed[country];
    }

    /// @inheritdoc IComplianceModule
    function moduleCheck(address token, address, address to, uint256) external view returns (bool) {
        return _allowed[ISecurityToken(token).identityRegistry().countryOf(to)];
    }

    /// @inheritdoc IComplianceModule
    function name() external pure returns (string memory) {
        return "CountryAllowModule";
    }
}
