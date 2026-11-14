import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { IdentityService } from './identity.service.js';

const uuid = z.uuid();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');

const createInvestorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  country: z.number().int().min(1).max(999),
  investorType: z.number().int().min(0).max(2),
});
type CreateInvestorDto = z.infer<typeof createInvestorSchema>;

const revokeSchema = z.object({
  // Stored on chain as bytes32, so at most 31 ASCII characters.
  reason: z.string().regex(/^[A-Z0-9_]{1,31}$/, 'expected an upper-case code of at most 31 characters'),
});
type RevokeDto = z.infer<typeof revokeSchema>;

@ApiTags('investors')
@ApiBearerAuth()
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Get('investors')
  @ApiOperation({ summary: 'List investors with their wallets and KYC status' })
  list() {
    return this.identity.listInvestors();
  }

  @Get('investors/:id')
  @ApiOperation({ summary: 'One investor' })
  get(@Param('id', { schema: uuid }) id: string) {
    return this.identity.getInvestor(id);
  }

  @Post('investors')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Onboard an investor: create a wallet and register its identity on chain' })
  create(@Body({ schema: createInvestorSchema }) body: CreateInvestorDto) {
    return this.identity.createInvestor(body);
  }

  @Post('investors/:id/wallets')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Add another wallet for the same investor' })
  addWallet(@Param('id', { schema: uuid }) id: string) {
    return this.identity.addWallet(id);
  }

  @Post('wallets/:address/renew')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Issue a fresh KYC claim for a wallet' })
  renew(@Param('address', { schema: address }) walletAddress: string) {
    return this.identity.renew(walletAddress);
  }

  @Post('wallets/:address/revoke')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: "Revoke a wallet's identity" })
  revoke(@Param('address', { schema: address }) walletAddress: string, @Body({ schema: revokeSchema }) body: RevokeDto) {
    return this.identity.revoke(walletAddress, body.reason);
  }
}
