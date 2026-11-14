// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title UpgradeTimelock
/// @notice Holds the token's upgrader role, so an upgrade must be announced on chain and can
///         only be executed after a delay. Holders and operators get time to review the new
///         implementation, or to react, before it takes effect.
/// @dev OpenZeppelin's TimelockController, unchanged. The contract administers itself:
///      changing the delay or the proposers also has to go through the delay.
contract UpgradeTimelock is TimelockController {
    /// @param minDelay Seconds between scheduling an upgrade and executing it.
    /// @param proposers Accounts that may schedule and cancel upgrades.
    /// @param executors Accounts that may execute an upgrade once its delay has passed.
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors
    ) TimelockController(minDelay, proposers, executors, address(0)) {}
}
