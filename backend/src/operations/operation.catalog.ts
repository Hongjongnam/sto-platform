import { z } from 'zod';
import type { ContractName } from '../chain/abi.generated.js';
import type { RoleName } from '../chain/deployment.js';
import { OperationType } from './operation.entity.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
// Whole units as a decimal string, so large values survive JSON.
const amount = z.string().regex(/^[1-9][0-9]{0,30}$/, 'expected a positive whole number as a string');
const supply = z.string().regex(/^(0|[1-9][0-9]{0,30})$/, 'expected a whole number as a string');

/** Parameters accepted for each operation type. */
export const paramsSchemas = {
  [OperationType.Mint]: z.strictObject({ to: address, amount }),
  [OperationType.Burn]: z.strictObject({ from: address, amount }),
  [OperationType.Pause]: z.strictObject({}),
  [OperationType.Unpause]: z.strictObject({}),
  [OperationType.FreezeAddress]: z.strictObject({ account: address }),
  [OperationType.UnfreezeAddress]: z.strictObject({ account: address }),
  [OperationType.FreezePartial]: z.strictObject({ account: address, amount }),
  [OperationType.UnfreezePartial]: z.strictObject({ account: address, amount }),
  [OperationType.ForcedTransfer]: z.strictObject({ from: address, to: address, amount }),
  [OperationType.Recovery]: z.strictObject({ lostWallet: address, newWallet: address }),
  [OperationType.SetRegisteredSupply]: z.strictObject({ amount: supply }),
} satisfies Record<OperationType, z.ZodType>;

interface OperationSpec {
  /** Role whose key signs the transaction. */
  signer: RoleName;
  contract: ContractName;
  method: string;
  /** Builds the call arguments; `reason` is the bytes32-encoded reason code. */
  args: (params: Record<string, string>, reason: string) => unknown[];
  /** Whether a second operator must approve before anything is sent. */
  needsApproval: boolean;
}

/**
 * How each operation maps to a contract call. Operations that override a holder's control
 * of their assets, or change the registered supply, need a second operator's approval and
 * the hash of a supporting document.
 */
export const OPERATIONS: Record<OperationType, OperationSpec> = {
  [OperationType.Mint]: {
    signer: 'issuer',
    contract: 'SecurityToken',
    method: 'mint',
    args: (p, reason) => [p.to, p.amount, reason],
    needsApproval: false,
  },
  [OperationType.Burn]: {
    signer: 'issuer',
    contract: 'SecurityToken',
    method: 'burn',
    args: (p, reason) => [p.from, p.amount, reason],
    needsApproval: false,
  },
  [OperationType.Pause]: {
    signer: 'pauser',
    contract: 'SecurityToken',
    method: 'pause',
    args: (_p, reason) => [reason],
    needsApproval: false,
  },
  [OperationType.Unpause]: {
    signer: 'pauser',
    contract: 'SecurityToken',
    method: 'unpause',
    args: (_p, reason) => [reason],
    needsApproval: false,
  },
  [OperationType.FreezeAddress]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'setAddressFrozen',
    args: (p, reason) => [p.account, true, reason],
    needsApproval: true,
  },
  [OperationType.UnfreezeAddress]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'setAddressFrozen',
    args: (p, reason) => [p.account, false, reason],
    needsApproval: true,
  },
  [OperationType.FreezePartial]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'freezePartialTokens',
    args: (p, reason) => [p.account, p.amount, reason],
    needsApproval: true,
  },
  [OperationType.UnfreezePartial]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'unfreezePartialTokens',
    args: (p, reason) => [p.account, p.amount, reason],
    needsApproval: true,
  },
  [OperationType.ForcedTransfer]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'forcedTransfer',
    args: (p, reason) => [p.from, p.to, p.amount, reason],
    needsApproval: true,
  },
  [OperationType.Recovery]: {
    signer: 'enforcer',
    contract: 'SecurityToken',
    method: 'recoveryAddress',
    args: (p, reason) => [p.lostWallet, p.newWallet, reason],
    needsApproval: true,
  },
  [OperationType.SetRegisteredSupply]: {
    signer: 'registrar',
    contract: 'SecurityToken',
    method: 'setRegisteredSupply',
    args: (p, reason) => [p.amount, reason],
    needsApproval: true,
  },
};
