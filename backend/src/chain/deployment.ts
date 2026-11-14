import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const deploymentSchema = z.object({
  chainId: z.string(),
  deployer: address,
  startBlock: z.number().int().nonnegative(),
  roles: z.object({
    admin: address,
    issuer: address,
    enforcer: address,
    pauser: address,
    registrar: address,
    upgrader: address,
    settlement: address,
    kycIssuer: address,
    treasury: address,
  }),
  contracts: z.object({
    identityRegistry: address,
    compliance: address,
    maxBalanceModule: address,
    maxHoldersModule: address,
    countryAllowModule: address,
    securityToken: address,
    securityTokenImplementation: address,
    upgradeTimelock: address,
    cash: address,
    dvpSettlement: address,
    dividendDistributor: address,
    redemptionManager: address,
  }),
});

/** Deployment record written by contracts/scripts/deploy.ts. */
export type Deployment = z.infer<typeof deploymentSchema>;
export type RoleName = keyof Deployment['roles'];

export function loadDeployment(file: string): Deployment {
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the deployment record at ${path}: ${(error as Error).message}`);
  }
  return deploymentSchema.parse(raw);
}
