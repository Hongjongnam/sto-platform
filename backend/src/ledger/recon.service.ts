import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { IndexerService } from './indexer.service.js';

export interface Mismatch {
  /** What was compared, for example `balance`, `frozen`, `totalSupply`, `investorBalance`. */
  field: string;
  /** Wallet address or investor id the value belongs to; absent for token-wide values. */
  subject?: string;
  ledger: string;
  chain: string;
}

export interface ReconReport {
  id: string;
  blockNumber: number;
  ok: boolean;
  walletsChecked: number;
  mismatches: Mismatch[];
  createdAt: string;
}

/**
 * Compares the internal ledger with the chain.
 *
 * The chain is the book of record: a difference means the ledger is wrong, and the remedy
 * is to rebuild the ledger from events, never to change the chain. To compare like with
 * like, the indexer is first brought to the chain head and every chain value is then read
 * at exactly the block the ledger reflects.
 */
@Injectable()
export class ReconService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly indexer: IndexerService,
  ) {}

  async run(): Promise<ReconReport> {
    const block = await this.indexer.syncToHead();
    const blockTag = block;
    const token = this.chain.contract('SecurityToken');
    const mismatches: Mismatch[] = [];
    const compare = (field: string, ledger: string, onChain: string, subject?: string) => {
      if (ledger !== onChain) mismatches.push({ field, subject, ledger, chain: onChain });
    };

    const holdings = await this.dataSource.query<{ wallet: string; balance: string; frozen: string; address_frozen: boolean }[]>(
      'SELECT wallet, balance, frozen, address_frozen FROM holdings ORDER BY wallet',
    );
    for (const holding of holdings) {
      const [balance, frozen, addressFrozen] = await Promise.all([
        token.balanceOf(holding.wallet, { blockTag }) as Promise<bigint>,
        token.getFrozenTokens(holding.wallet, { blockTag }) as Promise<bigint>,
        token.isFrozen(holding.wallet, { blockTag }) as Promise<boolean>,
      ]);
      compare('balance', holding.balance, balance.toString(), holding.wallet);
      compare('frozen', holding.frozen, frozen.toString(), holding.wallet);
      compare('addressFrozen', String(holding.address_frozen), String(addressFrozen), holding.wallet);
    }

    const [state] = await this.dataSource.query<{ total_supply: string; registered_supply: string; paused: boolean }[]>(
      'SELECT total_supply, registered_supply, paused FROM token_state WHERE id = 1',
    );
    const [totalSupply, registeredSupply, paused, holderCount] = await Promise.all([
      token.totalSupply({ blockTag }) as Promise<bigint>,
      token.registeredSupply({ blockTag }) as Promise<bigint>,
      token.paused({ blockTag }) as Promise<boolean>,
      token.holderCount({ blockTag }) as Promise<bigint>,
    ]);
    compare('totalSupply', state.total_supply, totalSupply.toString());
    compare('registeredSupply', state.registered_supply, registeredSupply.toString());
    compare('paused', String(state.paused), String(paused));
    const [{ sum }] = await this.dataSource.query<{ sum: string }[]>('SELECT COALESCE(SUM(balance), 0)::text AS sum FROM holdings');
    compare('sumOfBalances', sum, totalSupply.toString());

    // Per-investor aggregates: the ledger's sum over an investor's wallets against the
    // token's own aggregate.
    const investors = await this.dataSource.query<{ investor_id: string; balance: string }[]>(
      `SELECT i.investor_id, COALESCE(SUM(h.balance), 0)::text AS balance
       FROM investors i
       JOIN wallets w ON w.investor_uuid = i.id
       LEFT JOIN holdings h ON h.wallet = w.address
       GROUP BY i.investor_id
       ORDER BY i.investor_id`,
    );
    let ledgerHolders = 0;
    for (const investor of investors) {
      const onChain: bigint = await token.investorBalanceOf(investor.investor_id, { blockTag });
      compare('investorBalance', investor.balance, onChain.toString(), investor.investor_id);
      if (investor.balance !== '0') ledgerHolders++;
    }
    compare('holderCount', String(ledgerHolders), holderCount.toString());

    const [row] = await this.dataSource.query<{ id: string; created_at: Date }[]>(
      `INSERT INTO recon_reports (block_number, ok, wallets_checked, mismatches)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id, created_at`,
      [block, mismatches.length === 0, holdings.length, JSON.stringify(mismatches)],
    );
    return {
      id: row.id,
      blockNumber: block,
      ok: mismatches.length === 0,
      walletsChecked: holdings.length,
      mismatches,
      createdAt: row.created_at.toISOString(),
    };
  }

  async list(limit = 50): Promise<ReconReport[]> {
    const rows = await this.dataSource.query<
      { id: string; block_number: string; ok: boolean; wallets_checked: number; mismatches: Mismatch[]; created_at: Date }[]
    >('SELECT * FROM recon_reports ORDER BY id DESC LIMIT $1', [limit]);
    return rows.map((row) => ({
      id: row.id,
      blockNumber: Number(row.block_number),
      ok: row.ok,
      walletsChecked: row.wallets_checked,
      mismatches: row.mismatches,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
