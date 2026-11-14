import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { ChainService } from '../chain/chain.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { OutboxService } from '../outbox/outbox.service.js';

const uuid = z.uuid();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
const positive = z.string().regex(/^[1-9][0-9]{0,30}$/, 'expected a positive whole number as a string');
const transferSchema = z.object({ to: address, amount: positive });

/**
 * Actions an investor takes with their own wallet. The backend is custodial, so the
 * investor's key signs here on their behalf.
 */
@ApiTags('investor wallet')
@ApiBearerAuth()
@Controller()
export class PortfolioController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    private readonly identity: IdentityService,
  ) {}

  @Get('wallets/:address/portfolio')
  @ApiOperation({ summary: "A wallet's security and cash balances, read from the chain" })
  async portfolio(@Param('address', { schema: address }) wallet: string) {
    await this.identity.findWallet(wallet);
    const token = this.chain.contract('SecurityToken');
    const [balance, frozen, addressFrozen, cash, verified] = await Promise.all([
      token.balanceOf(wallet) as Promise<bigint>,
      token.getFrozenTokens(wallet) as Promise<bigint>,
      token.isFrozen(wallet) as Promise<boolean>,
      this.chain.contract('USDC').balanceOf(wallet) as Promise<bigint>,
      this.chain.contract('IdentityRegistry').isVerified(wallet) as Promise<boolean>,
    ]);
    return {
      wallet,
      balance: balance.toString(),
      frozen: frozen.toString(),
      free: (balance - frozen).toString(),
      addressFrozen,
      cash: cash.toString(),
      verified,
    };
  }

  @Post('wallets/:address/transfers')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Transfer units from a wallet, signed by the wallet itself' })
  async transfer(@Param('address', { schema: address }) wallet: string, @Body({ schema: transferSchema }) body: z.infer<typeof transferSchema>) {
    await this.identity.findWallet(wallet);
    const entry = await this.dataSource.transaction((manager) =>
      this.outbox.enqueue(manager, {
        idempotencyKey: `transfer:${wallet}:${crypto.randomUUID()}`,
        signer: wallet,
        contract: 'SecurityToken',
        method: 'transfer',
        args: [body.to, body.amount],
      }),
    );
    return { transactionId: entry.id };
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Status of a transaction the backend was asked to send' })
  async transaction(@Param('id', { schema: uuid }) id: string) {
    const entry = await this.outbox.findById(id);
    if (!entry) throw new NotFoundException('Transaction not found');
    return {
      id: entry.id,
      contract: entry.contract,
      method: entry.method,
      signer: entry.signer,
      status: entry.status,
      txHash: entry.txHash,
      blockNumber: entry.blockNumber,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
    };
  }
}
