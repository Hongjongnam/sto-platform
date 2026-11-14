import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { encodeBytes32String, id as keccakId } from 'ethers';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { OutboxEntry, OutboxStatus } from '../outbox/outbox.entity.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { Wallet } from '../identity/wallet.entity.js';
import { Trade } from './trade.entity.js';

const TRADE_TYPES = {
  Trade: [
    { name: 'tradeId', type: 'bytes32' },
    { name: 'seller', type: 'address' },
    { name: 'buyer', type: 'address' },
    { name: 'security', type: 'address' },
    { name: 'cash', type: 'address' },
    { name: 'quantity', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
};
const TRADE_VALIDITY_SECONDS = 24 * 60 * 60;

export type TradeStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'CANCELLING' | 'CANCELLED';

export interface TradeView {
  id: string;
  tradeNo: string;
  tradeId: string;
  seller: string;
  buyer: string;
  quantity: string;
  price: string;
  expiry: string;
  status: TradeStatus;
  settleAttempts: number;
  txHash: string | null;
  /** Why the latest attempt failed, when `status` is `FAILED`. */
  failure: { step: string; errorCode: string | null; errorMessage: string | null } | null;
  createdAt: string;
}

export interface TradeReport {
  /** Trade number assigned by the venue. */
  tradeNo: string;
  seller: string;
  buyer: string;
  quantity: string;
  price: string;
}

/**
 * Turns a trade reported by the venue into a delivery-versus-payment settlement.
 *
 * One report produces four transactions, recorded together in the outbox: the trade
 * registration with both parties' signatures, each party's allowance for its own leg, and
 * the settlement itself, which waits for the other three.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    @InjectRepository(Trade) private readonly trades: Repository<Trade>,
    @InjectRepository(OutboxEntry) private readonly entries: Repository<OutboxEntry>,
  ) {}

  /** Accepts a trade report. Reporting the same trade number again returns the existing trade. */
  async receive(report: TradeReport): Promise<TradeView> {
    if (report.seller === report.buyer) throw new BadRequestException('seller and buyer must differ');

    const id = await this.dataSource.transaction(async (manager) => {
      // Serialises reports of the same trade number.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [report.tradeNo]);
      const existing = await manager.findOneBy(Trade, { tradeNo: report.tradeNo });
      if (existing) return existing.id;

      for (const party of [report.seller, report.buyer]) {
        if (!(await manager.findOneBy(Wallet, { address: party }))) {
          throw new BadRequestException(`wallet ${party} is not managed here`);
        }
      }

      const latest = await this.chain.provider.getBlock('latest');
      const expirySeconds = latest!.timestamp + TRADE_VALIDITY_SECONDS;
      const terms = {
        tradeId: keccakId(report.tradeNo),
        seller: report.seller,
        buyer: report.buyer,
        security: this.chain.addressOf('SecurityToken'),
        cash: this.chain.addressOf('USDC'),
        quantity: report.quantity,
        price: report.price,
        expiry: String(expirySeconds),
      };
      const domain = {
        name: 'DvPSettlement',
        version: '1',
        chainId: BigInt(this.chain.deployment.chainId),
        verifyingContract: this.chain.addressOf('DvPSettlement'),
      };
      // Custodial model: each party's key signs the exact terms on the investor's behalf.
      const sellerSignature = await this.chain.signerFor(report.seller).signTypedData(domain, TRADE_TYPES, terms);
      const buyerSignature = await this.chain.signerFor(report.buyer).signTypedData(domain, TRADE_TYPES, terms);

      const settlement = this.chain.deployment.roles.settlement;
      const create = await this.outbox.enqueue(manager, {
        idempotencyKey: `trade:${report.tradeNo}:create`,
        signer: settlement,
        contract: 'DvPSettlement',
        method: 'createTrade',
        args: [terms, sellerSignature, buyerSignature],
      });
      const settle = await this.enqueueSettlement(manager, { ...report, tradeId: terms.tradeId }, 1, [create.id]);

      const trade = manager.create(Trade, {
        tradeNo: report.tradeNo,
        tradeId: terms.tradeId,
        seller: report.seller,
        buyer: report.buyer,
        quantity: report.quantity,
        price: report.price,
        expiry: new Date(expirySeconds * 1000),
        createOutboxId: create.id,
        settleOutboxId: settle.id,
      });
      return (await manager.save(trade)).id;
    });
    return this.get(id);
  }

  /** Tries again to settle a trade whose last attempt failed, once the cause has been fixed. */
  async retry(id: string): Promise<TradeView> {
    await this.dataSource.transaction(async (manager) => {
      const trade = await this.lock(manager, id);
      const view = (await this.toViews([trade], manager))[0];
      if (view.status !== 'FAILED') throw new ConflictException(`Only a failed trade can be retried; this one is ${view.status}`);
      if (view.failure?.step === 'createTrade') {
        throw new ConflictException('The trade was never registered on chain and cannot be retried');
      }
      const attempt = trade.settleAttempts + 1;
      const settle = await this.enqueueSettlement(manager, trade, attempt, []);
      trade.settleOutboxId = settle.id;
      trade.settleAttempts = attempt;
      await manager.save(trade);
    });
    return this.get(id);
  }

  /** Cancels a trade that has not settled. */
  async cancel(id: string, reasonCode: string): Promise<TradeView> {
    await this.dataSource.transaction(async (manager) => {
      const trade = await this.lock(manager, id);
      const view = (await this.toViews([trade], manager))[0];
      if (view.status !== 'FAILED' && view.status !== 'PENDING') {
        throw new ConflictException(`A ${view.status.toLowerCase()} trade cannot be cancelled`);
      }
      const cancel = await this.outbox.enqueue(manager, {
        idempotencyKey: `trade:${trade.tradeNo}:cancel`,
        signer: this.chain.deployment.roles.settlement,
        contract: 'DvPSettlement',
        method: 'cancel',
        args: [trade.tradeId, encodeBytes32String(reasonCode)],
        dependsOn: [trade.createOutboxId],
      });
      trade.cancelOutboxId = cancel.id;
      await manager.save(trade);
    });
    return this.get(id);
  }

  async list(): Promise<TradeView[]> {
    return this.toViews(await this.trades.find({ order: { createdAt: 'DESC' }, take: 200 }));
  }

  async get(id: string): Promise<TradeView> {
    const trade = await this.trades.findOneBy({ id });
    if (!trade) throw new NotFoundException('Trade not found');
    return (await this.toViews([trade]))[0];
  }

  /** Records both allowances and the settlement that depends on them. */
  private async enqueueSettlement(
    manager: EntityManager,
    trade: { tradeNo: string; tradeId: string; seller: string; buyer: string; quantity: string; price: string },
    attempt: number,
    alsoDependsOn: string[],
  ): Promise<OutboxEntry> {
    const dvp = this.chain.addressOf('DvPSettlement');
    // An allowance is a single number per party. If two trades of the same party were in
    // flight at once, the second approval would overwrite the first before it is used. Each
    // approval therefore waits for that party's previous settlement to finish.
    const previousSettlement = async (column: 'seller' | 'buyer', party: string): Promise<string[]> => {
      const rows = await manager.query<{ settle_outbox_id: string }[]>(
        `SELECT settle_outbox_id FROM trades WHERE ${column} = $1 AND trade_no <> $2 ORDER BY created_at DESC LIMIT 1`,
        [party, trade.tradeNo],
      );
      return rows.map((row) => row.settle_outbox_id);
    };
    const sellerApproval = await this.outbox.enqueue(manager, {
      idempotencyKey: `trade:${trade.tradeNo}:approve-security:${attempt}`,
      signer: trade.seller,
      contract: 'SecurityToken',
      method: 'approve',
      args: [dvp, trade.quantity],
      runsAfter: await previousSettlement('seller', trade.seller),
    });
    const buyerApproval = await this.outbox.enqueue(manager, {
      idempotencyKey: `trade:${trade.tradeNo}:approve-cash:${attempt}`,
      signer: trade.buyer,
      contract: 'USDC',
      method: 'approve',
      args: [dvp, trade.price],
      runsAfter: await previousSettlement('buyer', trade.buyer),
    });
    return this.outbox.enqueue(manager, {
      idempotencyKey: `trade:${trade.tradeNo}:settle:${attempt}`,
      signer: this.chain.deployment.roles.settlement,
      contract: 'DvPSettlement',
      method: 'settle',
      args: [trade.tradeId],
      dependsOn: [...alsoDependsOn, sellerApproval.id, buyerApproval.id],
    });
  }

  private async lock(manager: EntityManager, id: string): Promise<Trade> {
    const trade = await manager.findOne(Trade, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!trade) throw new NotFoundException('Trade not found');
    return trade;
  }

  private async toViews(trades: Trade[], manager?: EntityManager): Promise<TradeView[]> {
    const ids = trades.flatMap((trade) => [trade.createOutboxId, trade.settleOutboxId, trade.cancelOutboxId]).filter((x): x is string => !!x);
    const repository = manager ? manager.getRepository(OutboxEntry) : this.entries;
    const entries = ids.length ? await repository.findBy({ id: In(ids) }) : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    return trades.map((trade) => {
      const create = byId.get(trade.createOutboxId);
      const settle = byId.get(trade.settleOutboxId);
      const cancel = trade.cancelOutboxId ? byId.get(trade.cancelOutboxId) : undefined;

      let status: TradeStatus = 'PENDING';
      let failure: TradeView['failure'] = null;
      if (cancel?.status === OutboxStatus.Confirmed) status = 'CANCELLED';
      else if (cancel && cancel.status !== OutboxStatus.Failed) status = 'CANCELLING';
      else if (settle?.status === OutboxStatus.Confirmed) status = 'SETTLED';
      else if (create?.status === OutboxStatus.Failed) {
        status = 'FAILED';
        failure = { step: 'createTrade', errorCode: create.errorCode, errorMessage: create.errorMessage };
      } else if (settle?.status === OutboxStatus.Failed) {
        status = 'FAILED';
        failure = { step: 'settle', errorCode: settle.errorCode, errorMessage: settle.errorMessage };
      }

      return {
        id: trade.id,
        tradeNo: trade.tradeNo,
        tradeId: trade.tradeId,
        seller: trade.seller,
        buyer: trade.buyer,
        quantity: trade.quantity,
        price: trade.price,
        expiry: trade.expiry.toISOString(),
        status,
        settleAttempts: trade.settleAttempts,
        txHash: status === 'SETTLED' ? (settle?.txHash ?? null) : null,
        failure,
        createdAt: trade.createdAt.toISOString(),
      };
    });
  }
}
