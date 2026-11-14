import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEntry } from './outbox.entity.js';
import { OutboxService } from './outbox.service.js';
import { OutboxWorker } from './outbox.worker.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEntry])],
  providers: [OutboxService, OutboxWorker],
  exports: [OutboxService, OutboxWorker],
})
export class OutboxModule {}
