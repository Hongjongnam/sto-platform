import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, Interface, JsonRpcProvider, type Signer } from 'ethers';
import type { Env } from '../config/env.js';
import { ABIS, type ContractName } from './abi.generated.js';
import { type Deployment, loadDeployment, type RoleName } from './deployment.js';
import { KeyStore } from './key-store.js';

/** Which deployed address each ABI is bound to. */
const ADDRESS_KEY: Record<ContractName, keyof Deployment['contracts']> = {
  IdentityRegistry: 'identityRegistry',
  SecurityToken: 'securityToken',
  ModularCompliance: 'compliance',
  MaxBalanceModule: 'maxBalanceModule',
  MaxHoldersModule: 'maxHoldersModule',
  CountryAllowModule: 'countryAllowModule',
  DvPSettlement: 'dvpSettlement',
  DividendDistributor: 'dividendDistributor',
  RedemptionManager: 'redemptionManager',
  USDC: 'cash',
};

export interface DecodedRevert {
  /** Custom error name, or `UNKNOWN` when the data matches no known ABI. */
  name: string;
  args: string[];
}

@Injectable()
export class ChainService {
  readonly provider: JsonRpcProvider;
  readonly deployment: Deployment;
  readonly keys: KeyStore;
  private readonly interfaces: Interface[];

  constructor(config: ConfigService<Env, true>) {
    this.deployment = loadDeployment(config.get('DEPLOYMENT_FILE', { infer: true }));
    this.provider = new JsonRpcProvider(config.get('RPC_URL', { infer: true }), BigInt(this.deployment.chainId), {
      staticNetwork: true,
      // ethers answers identical requests from a short-lived cache by default. Nonces and
      // receipts must always be read fresh.
      cacheTimeout: -1,
    });
    this.keys = new KeyStore(config.get('CHAIN_MNEMONIC', { infer: true }));
    this.interfaces = Object.values(ABIS).map((abi) => new Interface(abi));
  }

  addressOf(name: ContractName): string {
    return this.deployment.contracts[ADDRESS_KEY[name]];
  }

  /** Contract bound to its deployed address, read-only unless a signer is given. */
  contract(name: ContractName, signer?: Signer): Contract {
    return new Contract(this.addressOf(name), ABIS[name], signer ?? this.provider);
  }

  /** Signer for the account that holds `role` in the deployment. */
  roleSigner(role: RoleName): Signer {
    return this.signerFor(this.deployment.roles[role]);
  }

  signerFor(address: string): Signer {
    return this.keys.forAddress(address).connect(this.provider);
  }

  /**
   * Decodes revert data against every known ABI. The node returns raw revert bytes; ethers
   * does not map them to custom error names by itself.
   */
  decodeRevert(error: unknown): DecodedRevert | undefined {
    const data = (error as { data?: unknown }).data ?? (error as { info?: { error?: { data?: unknown } } }).info?.error?.data;
    if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return undefined;
    for (const contractInterface of this.interfaces) {
      try {
        const parsed = contractInterface.parseError(data);
        if (parsed) return { name: parsed.name, args: parsed.args.map((arg) => String(arg)) };
      } catch {
        // not an error of this contract
      }
    }
    return { name: 'UNKNOWN', args: [data] };
  }
}
