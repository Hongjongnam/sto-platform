import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import { CorporateActionsController } from './corporate-actions.controller.js';
import { CorporateActionsService } from './corporate-actions.service.js';

@Module({
  imports: [LedgerModule],
  controllers: [CorporateActionsController],
  providers: [CorporateActionsService],
})
export class CorporateActionsModule {}
