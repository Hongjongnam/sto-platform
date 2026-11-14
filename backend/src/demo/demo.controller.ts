import { Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Public, Roles } from '../auth/auth.decorators.js';
import { AuthService } from '../auth/auth.service.js';
import { OperatorRole } from '../auth/operator.entity.js';
import type { Env } from '../config/env.js';

const DEMO_OPERATORS = [
  { key: 'requester', username: 'demo-requester', displayName: '요청 담당자', roles: [OperatorRole.Requester] },
  { key: 'approver', username: 'demo-approver', displayName: '승인 담당자', roles: [OperatorRole.Approver] },
] as const;

/**
 * Endpoints that exist only for a public demo. Every handler refuses to run unless
 * `DEMO_MODE=on`.
 */
@ApiTags('demo')
@Controller('demo')
export class DemoController {
  private readonly enabled: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly auth: AuthService,
    private readonly dataSource: DataSource,
  ) {
    this.enabled = config.get('DEMO_MODE', { infer: true }) === 'on';
  }

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Whether demo mode is on' })
  status() {
    return { enabled: this.enabled };
  }

  @Public()
  @Post('session')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in to the demo without credentials: returns one token per demo operator' })
  async session() {
    this.requireDemo();
    const session: Record<string, { accessToken: string; displayName: string }> = {};
    for (const operator of DEMO_OPERATORS) {
      // The password is random and discarded: these accounts are reachable only through this endpoint.
      const password = randomBytes(24).toString('base64url');
      await this.auth.upsertOperator({ ...operator, roles: [...operator.roles], password });
      const { accessToken } = await this.auth.login(operator.username, password);
      session[operator.key] = { accessToken, displayName: operator.displayName };
    }
    return session;
  }

  @Post('ledger/corrupt')
  @HttpCode(200)
  @Roles(OperatorRole.Requester, OperatorRole.Approver)
  @ApiOperation({ summary: 'Deliberately falsify one balance in the internal ledger, for the reconciliation walkthrough' })
  async corruptLedger() {
    this.requireDemo();
    const [target] = await this.dataSource.query<{ wallet: string }[]>(
      'SELECT wallet FROM holdings ORDER BY balance DESC, wallet LIMIT 1',
    );
    if (!target) throw new NotFoundException('The ledger has no holdings to corrupt yet');
    await this.dataSource.query('UPDATE holdings SET balance = balance + 7 WHERE wallet = $1', [target.wallet]);
    const [row] = await this.dataSource.query<{ wallet: string; balance: string }[]>(
      'SELECT wallet, balance::text AS balance FROM holdings WHERE wallet = $1',
      [target.wallet],
    );
    return { wallet: row.wallet, ledgerBalance: row.balance, addedToLedger: '7' };
  }

  private requireDemo(): void {
    // Indistinguishable from a route that does not exist.
    if (!this.enabled) throw new NotFoundException();
  }
}
