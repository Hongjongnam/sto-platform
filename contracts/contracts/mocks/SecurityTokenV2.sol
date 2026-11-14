// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SecurityToken} from "../token/SecurityToken.sol";

/// @title SecurityTokenV2
/// @notice Upgrade target used in tests: same storage, one added function.
/// @custom:oz-upgrades-from SecurityToken
contract SecurityTokenV2 is SecurityToken {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Runs once when a proxy is upgraded to this version.
    /// @dev The parent initializers already ran in `initialize`, so they are not called again.
    /// @custom:oz-upgrades-validate-as-initializer
    /// @custom:oz-upgrades-unsafe-allow missing-initializer-call
    function initializeV2() external reinitializer(2) {}

    function version() external pure returns (string memory) {
        return "2";
    }
}
