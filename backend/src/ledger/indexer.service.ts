import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Interface, type Log, type Result } from 'ethers';
import { DataSource } from 'typeorm';
import { ABIS, type ContractName } from '../chain/abi.generated.js';
import { ChainService } from '../chain/chain.service.js';
import { applyEvent, resetLedger } from './ledger.projection.js';

const INDEXED: ContractName[] = ['SecurityToken', 'IdentityRegistry', 'DvPSettlement', 'DividendDistributor', 'RedemptionManager'];
const MAX_BLOCKS_PER_BATCH = 2_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Reads contract events into `chain_events` and keeps the internal ledger in step.
 *
 * Idempotent by construction: events are unique on (transaction hash, log index), only
 * newly inserted events are applied to the ledger, and the cursor moves in the same
 * database transaction. A batch that fails midway rolls back completely and is simply
 * read again. The network has immediate finality, so there are no reorganisations to undo.
 */
@Injectable()
export class IndexerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IndexerService.name);
  private readonly sources: { name: ContractName; address: string; abi: Interface }[];
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
  ) {
    this.sources = INDEXED.map((name) => ({
      name,
      address: chain.addressOf(name).toLowerCase(),
      abi: new Interface(ABIS[name]),
    }));
  }

  onApplicationBootstrap(): void {
    if (process.env.INDEXER_WORKER === 'off') return;
    this.timer = setInterval(() => void this.syncOnce().catch((error) => this.logger.warn(error.message)), POLL_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Last block whose events are fully reflected in the ledger. */
  async cursor(): Promise<number> {
    const [row] = await this.dataSource.query<{ last_block: string }[]>('SELECT last_block FROM indexer_cursor WHERE id = 1');
    return row ? Number(row.last_block) : this.chain.deployment.startBlock - 1;
  }

  /** Processes one batch of blocks. Returns the block the ledger now reflects. */
  async syncOnce(): Promise<number> {
    if (this.running) return this.cursor();
    this.running = true;
    try {
      const latest = await this.chain.provider.getBlockNumber();
      const from = (await this.cursor()) + 1;
      if (from > latest) return latest;
      const to = Math.min(from + MAX_BLOCKS_PER_BATCH - 1, latest);

      const logs = await this.chain.provider.getLogs({
        address: this.sources.map((source) => source.address),
        fromBlock: from,
        toBlock: to,
      });
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      await this.dataSource.transaction(async (manager) => {
        for (const log of logs) {
          const decoded = this.decode(log);
          if (!decoded) continue;
          const inserted = await manager.query<{ id: string }[]>(
            `INSERT INTO chain_events (tx_hash, log_index, block_number, contract, name, args)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (tx_hash, log_index) DO NOTHING
             RETURNING id`,
            [log.transactionHash, log.index, log.blockNumber, decoded.contract, decoded.name, JSON.stringify(decoded.args)],
          );
          if (inserted.length > 0) await applyEvent(manager, { ...decoded, blockNumber: log.blockNumber });
        }
        await manager.query(
          `INSERT INTO indexer_cursor (id, last_block) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET last_block = $1`,
          [to],
        );
      });
      return to;
    } finally {
      this.running = false;
    }
  }

  /** Runs until the ledger reflects the chain head. */
  async syncToHead(): Promise<number> {
    for (;;) {
      const reached = await this.syncOnce();
      if (reached >= (await this.chain.provider.getBlockNumber())) return reached;
    }
  }

  /** Rebuilds the ledger from the stored events, without reading the chain. */
  async rebuildLedger(): Promise<{ events: number }> {
    return this.dataSource.transaction(async (manager) => {
      // Keeps the indexer from applying new events while the ledger is being replayed.
      await manager.query('LOCK TABLE indexer_cursor IN EXCLUSIVE MODE');
      await resetLedger(manager);
      const events = await manager.query<{ contract: string; name: string; args: Record<string, string>; block_number: string }[]>(
        'SELECT contract, name, args, block_number FROM chain_events ORDER BY block_number, log_index',
      );
      for (const event of events) {
        await applyEvent(manager, { contract: event.contract, name: event.name, args: event.args, blockNumber: Number(event.block_number) });
      }
      return { events: events.length };
    });
  }

  private decode(log: Log): { contract: ContractName; name: string; args: Record<string, string> } | undefined {
    const source = this.sources.find((candidate) => candidate.address === log.address.toLowerCase());
    if (!source) return undefined;
    const parsed = source.abi.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return undefined;
    return { contract: source.name, name: parsed.name, args: namedArgs(parsed.args, parsed.fragment.inputs.map((input) => input.name)) };
  }
}

/** Event arguments keyed by name, with every value rendered as a string. */
function namedArgs(args: Result, names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  names.forEach((name, index) => {
    result[name || `arg${index}`] = String(args[index]);
  });
  return result;
}
