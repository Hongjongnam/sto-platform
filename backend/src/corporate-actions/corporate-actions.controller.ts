import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { CorporateActionsService } from './corporate-actions.service.js';

const uuid = z.uuid();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
const positive = z.string().regex(/^[1-9][0-9]{0,30}$/, 'expected a positive whole number as a string');
const claimDays = z.number().int().min(1).max(365);

const openDividendSchema = z.object({ totalAmount: positive, claimDays });
const openRedemptionSchema = z.object({ pricePerUnit: positive, claimDays });
const claimSchema = z.object({ wallet: address });
const redeemSchema = z.object({ wallet: address, quantity: positive });

@ApiTags('corporate actions')
@ApiBearerAuth()
@Controller()
export class CorporateActionsController {
  constructor(private readonly actions: CorporateActionsService) {}

  @Get('dividends')
  @ApiOperation({ summary: 'Dividends with their claims' })
  dividends() {
    return this.actions.list('DIVIDEND');
  }

  @Get('dividends/:id')
  @ApiOperation({ summary: 'One dividend' })
  dividend(@Param('id', { schema: uuid }) id: string) {
    return this.actions.get(id, 'DIVIDEND');
  }

  @Post('dividends')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Open a dividend on balances at the current block' })
  openDividend(@Body({ schema: openDividendSchema }) body: z.infer<typeof openDividendSchema>) {
    return this.actions.openDividend(body);
  }

  @Post('dividends/:id/claims')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: "Claim a wallet's share" })
  claimDividend(@Param('id', { schema: uuid }) id: string, @Body({ schema: claimSchema }) body: z.infer<typeof claimSchema>) {
    return this.actions.claim('DIVIDEND', id, body.wallet);
  }

  @Post('dividends/:id/sweep')
  @HttpCode(200)
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'After the deadline, return unclaimed cash to the treasury' })
  sweep(@Param('id', { schema: uuid }) id: string) {
    return this.actions.close('DIVIDEND', id);
  }

  @Get('redemptions')
  @ApiOperation({ summary: 'Redemption rounds with their claims' })
  redemptions() {
    return this.actions.list('REDEMPTION');
  }

  @Get('redemptions/:id')
  @ApiOperation({ summary: 'One redemption round' })
  redemption(@Param('id', { schema: uuid }) id: string) {
    return this.actions.get(id, 'REDEMPTION');
  }

  @Post('redemptions')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'Open a redemption round at a price per unit' })
  openRedemption(@Body({ schema: openRedemptionSchema }) body: z.infer<typeof openRedemptionSchema>) {
    return this.actions.openRedemption(body);
  }

  @Post('redemptions/:id/redeem')
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: "Redeem units held by a wallet" })
  redeem(@Param('id', { schema: uuid }) id: string, @Body({ schema: redeemSchema }) body: z.infer<typeof redeemSchema>) {
    return this.actions.claim('REDEMPTION', id, body.wallet, body.quantity);
  }

  @Post('redemptions/:id/close')
  @HttpCode(200)
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'After the deadline, return the unpaid deposit to the treasury' })
  close(@Param('id', { schema: uuid }) id: string) {
    return this.actions.close('REDEMPTION', id);
  }
}
