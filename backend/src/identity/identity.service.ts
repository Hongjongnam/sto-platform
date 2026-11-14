import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { encodeBytes32String, id as keccakId } from 'ethers';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { KeyStore } from '../chain/key-store.js';
import { OutboxEntry, OutboxStatus } from '../outbox/outbox.entity.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { Investor } from './investor.entity.js';
import { Wallet, WalletAction } from './wallet.entity.js';

const CLAIM_TYPES = {
  InvestorClaim: [
    { name: 'wallet', type: 'address' },
    { name: 'investorId', type: 'bytes32' },
    { name: 'country', type: 'uint16' },
    { name: 'investorType', type: 'uint8' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const KYC_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

export type KycStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'REVOKED' | 'FAILED';

export interface WalletView {
  address: string;
  kycStatus: KycStatus;
  kycExpiry: string;
  /** Reason the last identity action failed, when `kycStatus` is `FAILED`. */
  failure: string | null;
}

export interface InvestorView {
  id: string;
  investorId: string;
  name: string;
  country: number;
  investorType: number;
  wallets: WalletView[];
}

/**
 * Mock KYC provider and registrar in one: issues signed claims with the KYC issuer key and
 * submits them to the identity registry through the outbox.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    @InjectRepository(Investor) private readonly investors: Repository<Investor>,
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectRepository(OutboxEntry) private readonly entries: Repository<OutboxEntry>,
  ) {}

  /** Onboards an investor with a first wallet and requests its registration on chain. */
  async createInvestor(input: { name: string; country: number; investorType: number }): Promise<InvestorView> {
    const investor = await this.dataSource.transaction(async (manager) => {
      const id = crypto.randomUUID();
      const saved = await manager.save(manager.create(Investor, { ...input, id, investorId: keccakId(`investor:${id}`) }));
      await this.addWalletIn(manager, saved);
      return saved;
    });
    return this.getInvestor(investor.id);
  }

  /** Gives an existing investor another wallet, linked to the same on-chain investor. */
  async addWallet(investorUuid: string): Promise<InvestorView> {
    await this.dataSource.transaction(async (manager) => {
      const investor = await manager.findOneBy(Investor, { id: investorUuid });
      if (!investor) throw new NotFoundException('Investor not found');
      await this.addWalletIn(manager, investor);
    });
    return this.getInvestor(investorUuid);
  }

  /** Issues a fresh claim for a wallet, extending its KYC. Also restores a revoked wallet. */
  async renew(address: string): Promise<InvestorView> {
    const investorUuid = await this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, address);
      await this.requestRegistration(manager, wallet.investor, wallet);
      await manager.save(wallet);
      return wallet.investorUuid;
    });
    return this.getInvestor(investorUuid);
  }

  /** Revokes a wallet's identity on chain. */
  async revoke(address: string, reason: string): Promise<InvestorView> {
    const investorUuid = await this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, address);
      const entry = await this.outbox.enqueue(manager, {
        idempotencyKey: `identity:revoke:${wallet.address}:${crypto.randomUUID()}`,
        signer: this.chain.deployment.roles.registrar,
        contract: 'IdentityRegistry',
        method: 'revokeIdentity',
        args: [wallet.address, encodeBytes32String(reason)],
      });
      wallet.lastAction = WalletAction.Revoke;
      wallet.lastOutboxId = entry.id;
      await manager.save(wallet);
      return wallet.investorUuid;
    });
    return this.getInvestor(investorUuid);
  }

  async listInvestors(): Promise<InvestorView[]> {
    const investors = await this.investors.find({ relations: { wallets: true }, order: { createdAt: 'ASC' } });
    return this.toViews(investors);
  }

  async getInvestor(id: string): Promise<InvestorView> {
    const investor = await this.investors.findOne({ where: { id }, relations: { wallets: true } });
    if (!investor) throw new NotFoundException('Investor not found');
    return (await this.toViews([investor]))[0];
  }

  /** Wallet row with its investor, or 404. */
  async findWallet(address: string): Promise<Wallet> {
    const wallet = await this.wallets.findOne({ where: { address }, relations: { investor: true } });
    if (!wallet) throw new NotFoundException(`Wallet ${address} is not managed here`);
    return wallet;
  }

  private async addWalletIn(manager: EntityManager, investor: Investor): Promise<Wallet> {
    // Serialises key allocation across concurrent requests.
    await manager.query('SELECT pg_advisory_xact_lock(727001)');
    const [{ next }] = await manager.query<{ next: number }[]>(
      'SELECT COALESCE(MAX(key_index) + 1, $1)::int AS next FROM wallets',
      [KeyStore.FIRST_INVESTOR_INDEX],
    );
    const address = this.chain.keys.derive(next).address;
    const wallet = manager.create(Wallet, { address, investorUuid: investor.id, keyIndex: next });
    await this.requestRegistration(manager, investor, wallet);
    return manager.save(wallet);
  }

  /** Signs a claim as the KYC issuer and enqueues its submission by the registrar. */
  private async requestRegistration(manager: EntityManager, investor: Investor, wallet: Wallet): Promise<void> {
    const registry = this.chain.contract('IdentityRegistry');
    const nonce: bigint = await registry.nonces(wallet.address);
    const latest = await this.chain.provider.getBlock('latest');
    const expiry = BigInt(latest!.timestamp) + BigInt(KYC_VALIDITY_SECONDS);
    const claim = {
      wallet: wallet.address,
      investorId: investor.investorId,
      country: investor.country,
      investorType: investor.investorType,
      expiry: expiry.toString(),
    };
    const domain = {
      name: 'IdentityRegistry',
      version: '1',
      chainId: BigInt(this.chain.deployment.chainId),
      verifyingContract: this.chain.addressOf('IdentityRegistry'),
    };
    const signature = await this.chain.roleSigner('kycIssuer').signTypedData(domain, CLAIM_TYPES, { ...claim, nonce });

    const entry = await this.outbox.enqueue(manager, {
      idempotencyKey: `identity:register:${wallet.address}:${nonce}`,
      signer: this.chain.deployment.roles.registrar,
      contract: 'IdentityRegistry',
      method: 'registerIdentity',
      args: [claim, signature],
    });
    wallet.kycExpiry = new Date(Number(expiry) * 1000);
    wallet.lastAction = WalletAction.Register;
    wallet.lastOutboxId = entry.id;
  }

  /** Loads a wallet for update and refuses a new action while the previous one is still in flight. */
  private async lockWallet(manager: EntityManager, address: string): Promise<Wallet> {
    const wallet = await manager.findOne(Wallet, {
      where: { address },
      relations: { investor: true },
      lock: { mode: 'pessimistic_write', tables: ['wallets'] },
    });
    if (!wallet) throw new NotFoundException(`Wallet ${address} is not managed here`);
    const last = await manager.findOneBy(OutboxEntry, { id: wallet.lastOutboxId });
    if (last && (last.status === OutboxStatus.Pending || last.status === OutboxStatus.Submitted)) {
      throw new ConflictException('The previous identity action for this wallet has not completed yet');
    }
    return wallet;
  }

  private async toViews(investors: Investor[]): Promise<InvestorView[]> {
    const outboxIds = investors.flatMap((investor) => investor.wallets.map((wallet) => wallet.lastOutboxId));
    const entries = outboxIds.length ? await this.entries.findBy({ id: In(outboxIds) }) : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const now = Date.now();

    return investors.map((investor) => ({
      id: investor.id,
      investorId: investor.investorId,
      name: investor.name,
      country: investor.country,
      investorType: investor.investorType,
      wallets: [...investor.wallets]
        .sort((a, b) => a.keyIndex - b.keyIndex)
        .map((wallet) => {
          const entry = byId.get(wallet.lastOutboxId);
          return {
            address: wallet.address,
            kycStatus: kycStatus(wallet, entry, now),
            kycExpiry: wallet.kycExpiry.toISOString(),
            failure: entry?.status === OutboxStatus.Failed ? `${entry.errorCode}: ${entry.errorMessage}` : null,
          };
        }),
    }));
  }
}

function kycStatus(wallet: Wallet, entry: OutboxEntry | undefined, now: number): KycStatus {
  if (!entry || entry.status === OutboxStatus.Pending || entry.status === OutboxStatus.Submitted) return 'PENDING';
  if (entry.status === OutboxStatus.Failed) return 'FAILED';
  if (wallet.lastAction === WalletAction.Revoke) return 'REVOKED';
  return wallet.kycExpiry.getTime() <= now ? 'EXPIRED' : 'VERIFIED';
}
