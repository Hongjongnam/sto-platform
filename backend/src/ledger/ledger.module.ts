import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service.js';
import { LedgerController } from './ledger.controller.js';
import { ReconService } from './recon.service.js';

@Module({
  controllers: [LedgerController],
  providers: [IndexerService, ReconService],
  exports: [IndexerService, ReconService],
})
export class LedgerModule {}
