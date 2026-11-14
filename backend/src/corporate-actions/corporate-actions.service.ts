import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { IndexerService } from '../ledger/indexer.service.js';
import { OutboxStatus } from '../outbox/outbox.entity.js';
import { OutboxService } from '../outbox/outbox.service.js';

export type ActionKind = 'DIVIDEND' | 'REDEMPTION';

interface ActionRow {
  id: string;
  kind: ActionKind;
  amount: string;
  record_block: string | null;
  deadline: Date;
  open_outbox_id: string;
  close_outbox_id: string | null;
  created_at: Date;
  open_status: OutboxStatus;
  open_tx_hash: string | null;
  open_error_code: string | null;
  open_error_message: string | null;
  close_status: OutboxStatus | null;
}

export interface ClaimView {
  wallet: string;
  quantity: string | null;
  status: OutboxStatus;
  /** Cash paid to the wallet, once confirmed on chain. */
  paid: string | null;
  errorCode: string | null;
}

export interface ActionView {
  id: string;
  kind: ActionKind;
  /** Total cash for a dividend; price per unit for a redemption. */
  amount: string;
  recordBlock: number | null;
  deadline: string;
  /** `OPENING` until the opening transaction confirms; `FAILED` if it was rejected. */
  status: 'OPENING' | 'OPEN' | 'FAILED' | 'CLOSING' | 'CLOSED';
  /** Identifier assigned by the contract, known once the opening transaction is indexed. */
  onChainId: string | null;
  failure: string | null;
  claims: ClaimView[];
  createdAt: string;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Dividends and redemptions. The treasury key funds and opens them; investor keys claim.
 * On the test network the treasury's cash comes from the test token's open mint.
 */
@Injectable()
export class CorporateActionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    private readonly indexer: IndexerService,
  ) {}

  /** Opens a dividend of `totalAmount` cash, shared pro rata by balances at the current block. */
  async openDividend(input: { totalAmount: string; claimDays: number }): Promise<ActionView> {
    const latest = await this.chain.provider.getBlock('latest');
    const deadline = latest!.timestamp + input.claimDays * DAY_SECONDS;
    const treasury = this.chain.deployment.roles.treasury;
    const distributor = this.chain.addressOf('DividendDistributor');

    const id = await this.dataSource.transaction(async (manager) => {
      const key = crypto.randomUUID();
      await this.fundTreasury(manager, key, distributor, input.totalAmount);
      const open = await this.outbox.enqueue(manager, {
        idempotencyKey: `dividend:${key}:open`,
        signer: treasury,
        contract: 'DividendDistributor',
        method: 'createDistribution',
        args: [
          this.chain.addressOf('SecurityToken'),
          this.chain.addressOf('USDC'),
          String(latest!.number),
          String(latest!.timestamp),
          input.totalAmount,
          String(deadline),
        ],
      });
      return this.insertAction(manager, 'DIVIDEND', input.totalAmount, latest!.number, deadline, open.id);
    });
    return this.get(id);
  }

  /** Opens a redemption round at `pricePerUnit`, funded for the whole outstanding supply. */
  async openRedemption(input: { pricePerUnit: string; claimDays: number }): Promise<ActionView> {
    const latest = await this.chain.provider.getBlock('latest');
    const deadline = latest!.timestamp + input.claimDays * DAY_SECONDS;
    const supply: bigint = await this.chain.contract('SecurityToken').totalSupply();
    if (supply === 0n) throw new BadRequestException('There is nothing outstanding to redeem');
    const deposit = (supply * BigInt(input.pricePerUnit)).toString();
    const treasury = this.chain.deployment.roles.treasury;

    const id = await this.dataSource.transaction(async (manager) => {
      const key = crypto.randomUUID();
      await this.fundTreasury(manager, key, this.chain.addressOf('RedemptionManager'), deposit);
      const open = await this.outbox.enqueue(manager, {
        idempotencyKey: `redemption:${key}:open`,
        signer: treasury,
        contract: 'RedemptionManager',
        method: 'openRedemption',
        args: [this.chain.addressOf('SecurityToken'), this.chain.addressOf('USDC'), input.pricePerUnit, String(deadline)],
      });
      return this.insertAction(manager, 'REDEMPTION', input.pricePerUnit, null, deadline, open.id);
    });
    return this.get(id);
  }

  /** Claims a wallet's share of a dividend, or redeems `quantity` units in a redemption round. */
  async claim(kind: ActionKind, id: string, wallet: string, quantity?: string): Promise<ActionView> {
    const action = await this.get(id, kind);
    if (action.status !== 'OPEN' || action.onChainId === null) {
      throw new ConflictException(`The ${kind.toLowerCase()} is ${action.status.toLowerCase()} and cannot be claimed`);
    }
    await this.dataSource.transaction(async (manager) => {
      const [managed] = await manager.query('SELECT 1 FROM wallets WHERE address = $1', [wallet]);
      if (!managed) throw new BadRequestException(`wallet ${wallet} is not managed here`);
      const entry = await this.outbox.enqueue(manager, {
        idempotencyKey: `${kind.toLowerCase()}:${id}:claim:${wallet}:${crypto.randomUUID()}`,
        signer: wallet,
        contract: kind === 'DIVIDEND' ? 'DividendDistributor' : 'RedemptionManager',
        method: kind === 'DIVIDEND' ? 'claim' : 'redeem',
        args: kind === 'DIVIDEND' ? [action.onChainId] : [action.onChainId, quantity],
      });
      await manager.query(
        'INSERT INTO corporate_action_claims (action_id, wallet, quantity, outbox_id) VALUES ($1, $2, $3, $4)',
        [id, wallet, quantity ?? null, entry.id],
      );
    });
    return this.get(id);
  }

  /** After the deadline: sweeps an unclaimed dividend or returns the unpaid redemption deposit to the treasury. */
  async close(kind: ActionKind, id: string): Promise<ActionView> {
    const action = await this.get(id, kind);
    if (action.status !== 'OPEN' || action.onChainId === null) {
      throw new ConflictException(`The ${kind.toLowerCase()} is ${action.status.toLowerCase()} and cannot be closed`);
    }
    const treasury = this.chain.deployment.roles.treasury;
    await this.dataSource.transaction(async (manager) => {
      const entry = await this.outbox.enqueue(manager, {
        idempotencyKey: `${kind.toLowerCase()}:${id}:close:${crypto.randomUUID()}`,
        signer: treasury,
        contract: kind === 'DIVIDEND' ? 'DividendDistributor' : 'RedemptionManager',
        method: kind === 'DIVIDEND' ? 'sweep' : 'close',
        args: [action.onChainId, treasury],
      });
      await manager.query('UPDATE corporate_actions SET close_outbox_id = $1 WHERE id = $2', [entry.id, id]);
    });
    return this.get(id);
  }

  async list(kind: ActionKind): Promise<ActionView[]> {
    const rows = await this.rows('a.kind = $1', [kind]);
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  async get(id: string, kind?: ActionKind): Promise<ActionView> {
    const [row] = await this.rows('a.id = $1', [id]);
    if (!row || (kind && row.kind !== kind)) throw new NotFoundException('Not found');
    return this.toView(row);
  }

  /** Test-network funding: mints the cash to the treasury and approves the contract to pull it. */
  private async fundTreasury(manager: EntityManager, key: string, spender: string, amount: string): Promise<void> {
    const treasury = this.chain.deployment.roles.treasury;
    await this.outbox.enqueue(manager, {
      idempotencyKey: `treasury:${key}:fund`,
      signer: treasury,
      contract: 'USDC',
      method: 'mint',
      args: [treasury, amount],
    });
    await this.outbox.enqueue(manager, {
      idempotencyKey: `treasury:${key}:approve`,
      signer: treasury,
      contract: 'USDC',
      method: 'approve',
      args: [spender, amount],
    });
  }

  private async insertAction(
    manager: EntityManager,
    kind: ActionKind,
    amount: string,
    recordBlock: number | null,
    deadline: number,
    openOutboxId: string,
  ): Promise<string> {
    const [row] = await manager.query<{ id: string }[]>(
      `INSERT INTO corporate_actions (kind, amount, record_block, deadline, open_outbox_id)
       VALUES ($1, $2, $3, to_timestamp($4), $5) RETURNING id`,
      [kind, amount, recordBlock, deadline, openOutboxId],
    );
    return row.id;
  }

  private rows(where: string, params: unknown[]): Promise<ActionRow[]> {
    return this.dataSource.query(
      `SELECT a.*, o.status AS open_status, o.tx_hash AS open_tx_hash, o.error_code AS open_error_code,
              o.error_message AS open_error_message, c.status AS close_status
       FROM corporate_actions a
       JOIN tx_outbox o ON o.id = a.open_outbox_id
       LEFT JOIN tx_outbox c ON c.id = a.close_outbox_id
       WHERE ${where}
       ORDER BY a.created_at DESC`,
      params,
    );
  }

  private async toView(row: ActionRow): Promise<ActionView> {
    const openedEvent = row.kind === 'DIVIDEND' ? 'DistributionCreated' : 'RedemptionOpened';
    const paidEvent = row.kind === 'DIVIDEND' ? 'DividendClaimed' : 'Redeemed';
    const paidField = row.kind === 'DIVIDEND' ? 'amount' : 'payout';

    let onChainId: string | null = null;
    if (row.open_status === OutboxStatus.Confirmed) {
      // The contract assigns the id; it is read from the event of the opening transaction.
      await this.indexer.syncToHead();
      const [event] = await this.dataSource.query<{ args: { id: string } }[]>(
        'SELECT args FROM chain_events WHERE tx_hash = $1 AND name = $2',
        [row.open_tx_hash, openedEvent],
      );
      onChainId = event?.args.id ?? null;
    }

    let status: ActionView['status'] = 'OPENING';
    if (row.open_status === OutboxStatus.Failed) status = 'FAILED';
    else if (row.close_status === OutboxStatus.Confirmed) status = 'CLOSED';
    else if (row.close_status && row.close_status !== OutboxStatus.Failed) status = 'CLOSING';
    else if (onChainId !== null) status = 'OPEN';

    const claims = await this.dataSource.query<
      { wallet: string; quantity: string | null; status: OutboxStatus; error_code: string | null; tx_hash: string | null }[]
    >(
      `SELECT c.wallet, c.quantity::text AS quantity, o.status, o.error_code, o.tx_hash
       FROM corporate_action_claims c JOIN tx_outbox o ON o.id = c.outbox_id
       WHERE c.action_id = $1 ORDER BY c.created_at`,
      [row.id],
    );
    const paidByTx = new Map<string, string>();
    const hashes = claims.map((claim) => claim.tx_hash).filter((hash): hash is string => hash !== null);
    if (hashes.length > 0) {
      const events = await this.dataSource.query<{ tx_hash: string; args: Record<string, string> }[]>(
        `SELECT tx_hash, args FROM chain_events WHERE tx_hash = ANY($1) AND name = $2 AND contract = $3`,
        [hashes, paidEvent, row.kind === 'DIVIDEND' ? 'DividendDistributor' : 'RedemptionManager'],
      );
      for (const event of events) paidByTx.set(event.tx_hash, event.args[paidField]);
    }

    return {
      id: row.id,
      kind: row.kind,
      amount: row.amount,
      recordBlock: row.record_block === null ? null : Number(row.record_block),
      deadline: row.deadline.toISOString(),
      status,
      onChainId,
      failure: status === 'FAILED' ? `${row.open_error_code}: ${row.open_error_message}` : null,
      claims: claims.map((claim) => ({
        wallet: claim.wallet,
        quantity: claim.quantity,
        status: claim.status,
        paid: claim.tx_hash ? (paidByTx.get(claim.tx_hash) ?? null) : null,
        errorCode: claim.error_code,
      })),
      createdAt: row.created_at.toISOString(),
    };
  }
}
