// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ICompliance} from "./ICompliance.sol";
import {IComplianceModule} from "./IComplianceModule.sol";

/// @title ModularCompliance
/// @notice Combines independent rule modules; a transfer is allowed only if every module accepts it.
/// @dev Holds no per-token state, so rules can change without redeploying or migrating the token.
contract ModularCompliance is ICompliance, Ownable2Step {
    /// @notice Upper bound on modules, which bounds the work done per transfer.
    uint256 public constant MAX_MODULES = 10;

    IComplianceModule[] private _modules;

    event ModuleAdded(address indexed module, address indexed operator);
    event ModuleRemoved(address indexed module, address indexed operator);

    error ZeroAddress();
    error TooManyModules();
    error ModuleAlreadyAdded(address module);
    error ModuleNotFound(address module);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Adds a rule module.
    function addModule(IComplianceModule module) external onlyOwner {
        if (address(module) == address(0)) revert ZeroAddress();
        uint256 length = _modules.length;
        if (length >= MAX_MODULES) revert TooManyModules();
        for (uint256 i; i < length; ++i) {
            if (_modules[i] == module) revert ModuleAlreadyAdded(address(module));
        }
        _modules.push(module);
        emit ModuleAdded(address(module), msg.sender);
    }

    /// @notice Removes a rule module.
    function removeModule(IComplianceModule module) external onlyOwner {
        uint256 length = _modules.length;
        for (uint256 i; i < length; ++i) {
            if (_modules[i] == module) {
                _modules[i] = _modules[length - 1];
                _modules.pop();
                emit ModuleRemoved(address(module), msg.sender);
                return;
            }
        }
        revert ModuleNotFound(address(module));
    }

    /// @inheritdoc ICompliance
    function canTransfer(address token, address from, address to, uint256 amount) external view returns (bool) {
        return firstFailingModule(token, from, to, amount) == address(0);
    }

    /// @notice First module that rejects the movement, or the zero address if all accept it.
    /// @dev Intended for off-chain callers that need to explain a rejection.
    function firstFailingModule(address token, address from, address to, uint256 amount) public view returns (address) {
        uint256 length = _modules.length;
        for (uint256 i; i < length; ++i) {
            if (!_modules[i].moduleCheck(token, from, to, amount)) return address(_modules[i]);
        }
        return address(0);
    }

    /// @notice Active modules.
    function modules() external view returns (IComplianceModule[] memory) {
        return _modules;
    }
}
