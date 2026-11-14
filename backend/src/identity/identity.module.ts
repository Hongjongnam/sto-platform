import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEntry } from '../outbox/outbox.entity.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { Investor } from './investor.entity.js';
import { Wallet } from './wallet.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Investor, Wallet, OutboxEntry])],
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
