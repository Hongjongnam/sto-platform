import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { ChainService } from '../chain/chain.service.js';
import { IndexerService } from './indexer.service.js';
import { ReconService } from './recon.service.js';

const eventsQuerySchema = z.object({
  name: z.string().max(100).optional(),
  contract: z.string().max(100).optional(),
  // Matches events whose arguments mention this address.
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
});

@ApiTags('ledger')
@ApiBearerAuth()
@Controller()
export class LedgerController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly indexer: IndexerService,
    private readonly recon: ReconService,
  ) {}

  @Get('ledger/state')
  @ApiOperation({ summary: 'Token-wide state as held in the internal ledger, and indexer progress' })
  async state() {
    const [state] = await this.dataSource.query<{ total_supply: string; registered_supply: string; paused: boolean }[]>(
      'SELECT total_supply, registered_supply, paused FROM token_state WHERE id = 1',
    );
    const [{ holders }] = await this.dataSource.query<{ holders: string }[]>(
      `SELECT COUNT(*) AS holders FROM (
         SELECT w.investor_uuid FROM holdings h JOIN wallets w ON w.address = h.wallet
         GROUP BY w.investor_uuid HAVING SUM(h.balance) > 0
       ) AS holding_investors`,
    );
    return {
      totalSupply: state.total_supply,
      registeredSupply: state.registered_supply,
      paused: state.paused,
      holders: Number(holders),
      indexedBlock: await this.indexer.cursor(),
      chainBlock: await this.chain.provider.getBlockNumber(),
    };
  }

  @Get('ledger/holdings')
  @ApiOperation({ summary: 'Balances per wallet as held in the internal ledger' })
  holdings() {
    return this.dataSource.query(
      `SELECT h.wallet, h.balance::text AS balance, h.frozen::text AS frozen,
              h.address_frozen AS "addressFrozen", h.updated_block::int AS "updatedBlock",
              i.id AS "investorUuid", i.name AS "investorName"
       FROM holdings h
       LEFT JOIN wallets w ON w.address = h.wallet
       LEFT JOIN investors i ON i.id = w.investor_uuid
       ORDER BY h.balance DESC, h.wallet`,
    );
  }

  @Get('events')
  @ApiOperation({ summary: 'Indexed chain events, newest first: the audit trail' })
  events(@Query({ schema: eventsQuerySchema }) query: z.infer<typeof eventsQuerySchema>) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.name) add('name = ?', query.name);
    if (query.contract) add('contract = ?', query.contract);
    if (query.address) add('args::text ILIKE ?', `%${query.address}%`);
    if (query.beforeId) add('id < ?', query.beforeId);
    params.push(query.limit);
    return this.dataSource.query(
      `SELECT id::int, tx_hash AS "txHash", log_index AS "logIndex", block_number::int AS "blockNumber",
              contract, name, args
       FROM chain_events
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
  }

  @Get('recon/reports')
  @ApiOperation({ summary: 'Reconciliation reports, newest first' })
  reports() {
    return this.recon.list();
  }

  @Post('recon/run')
  @HttpCode(200)
  @Roles(OperatorRole.Requester, OperatorRole.Approver)
  @ApiOperation({ summary: 'Compare the internal ledger with the chain now' })
  run() {
    return this.recon.run();
  }

  @Post('recon/rebuild')
  @HttpCode(200)
  @Roles(OperatorRole.Approver)
  @ApiOperation({ summary: 'Rebuild the internal ledger from the stored chain events' })
  rebuild() {
    return this.indexer.rebuildLedger();
  }
}
