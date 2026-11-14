import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Wallet } from '../identity/wallet.entity.js';
import { OutboxEntry } from '../outbox/outbox.entity.js';
import { SettlementController } from './settlement.controller.js';
import { SettlementService } from './settlement.service.js';
import { Trade } from './trade.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Trade, Wallet, OutboxEntry])],
  controllers: [SettlementController],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
