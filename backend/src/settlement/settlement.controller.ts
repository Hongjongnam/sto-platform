import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { ChainService } from '../chain/chain.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { SettlementService } from './settlement.service.js';

const uuid = z.uuid();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
const positive = z.string().regex(/^[1-9][0-9]{0,30}$/, 'expected a positive whole number as a string');
const nonNegative = z.string().regex(/^(0|[1-9][0-9]{0,30})$/, 'expected a whole number as a string');

const tradeReportSchema = z.object({
  tradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected letters, digits, "-" or "_"'),
  seller: address,
  buyer: address,
  quantity: positive,
  price: nonNegative,
});
const mockTradeSchema = tradeReportSchema.omit({ tradeNo: true });
const cancelSchema = z.object({
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,31}$/, 'expected an upper-case code of at most 31 characters'),
});
const fundSchema = z.object({ amount: positive });

@ApiTags('settlement')
@ApiBearerAuth()
@Controller()
export class SettlementController {
  constructor(
    private readonly settlement: SettlementService,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    private readonly dataSource: DataSource,
  ) {}

  @Get('trades')
  @ApiOperation({ summary: 'Trades with their settlement status, newest first' })
  list() {
    return this.settlement.list();
  }

  @Get('trades/:id')
  @ApiOperation({ summary: 'One trade' })
  get(@Param('id', { schema: uuid }) id: string) {
    return this.settlement.get(id);
  }

  @Post('trades')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Report a trade from the venue; the same trade number is accepted once' })
  report(@Body({ schema: tradeReportSchema }) body: z.infer<typeof tradeReportSchema>) {
    return this.settlement.receive(body);
  }

  @Post('otc/trades')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Mock venue: generate a trade number and report the trade' })
  async mockTrade(@Body({ schema: mockTradeSchema }) body: z.infer<typeof mockTradeSchema>) {
    const [{ next }] = await this.dataSource.query<{ next: string }[]>("SELECT nextval('otc_trade_seq') AS next");
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return this.settlement.receive({ ...body, tradeNo: `OTC-${day}-${next.padStart(6, '0')}` });
  }

  @Post('trades/:id/retry')
  @HttpCode(200)
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Retry the settlement of a failed trade' })
  retry(@Param('id', { schema: uuid }) id: string) {
    return this.settlement.retry(id);
  }

  @Post('trades/:id/cancel')
  @HttpCode(200)
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Cancel a trade that has not settled' })
  cancel(@Param('id', { schema: uuid }) id: string, @Body({ schema: cancelSchema }) body: z.infer<typeof cancelSchema>) {
    return this.settlement.cancel(id, body.reasonCode);
  }

  @Post('wallets/:address/cash')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Test faucet: mint test cash to a wallet so it can pay for trades' })
  async fund(@Param('address', { schema: address }) wallet: string, @Body({ schema: fundSchema }) body: z.infer<typeof fundSchema>) {
    const entry = await this.dataSource.transaction((manager) =>
      this.outbox.enqueue(manager, {
        idempotencyKey: `faucet:${wallet}:${crypto.randomUUID()}`,
        signer: this.chain.deployment.roles.treasury,
        contract: 'USDC',
        method: 'mint',
        args: [wallet, body.amount],
      }),
    );
    return { outboxId: entry.id };
  }
}
