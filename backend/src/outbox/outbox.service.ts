import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, Repository } from 'typeorm';
import type { ContractName } from '../chain/abi.generated.js';
import { OutboxEntry } from './outbox.entity.js';

export interface EnqueueInput {
  /** Stable key for the business action, for example `mint:<request id>`. */
  idempotencyKey: string;
  /** Account that signs the transaction. */
  signer: string;
  contract: ContractName;
  method: string;
  /** Call arguments. Use decimal strings for integers so they survive JSON. */
  args: unknown[];
}

@Injectable()
export class OutboxService {
  constructor(@InjectRepository(OutboxEntry) private readonly entries: Repository<OutboxEntry>) {}

  /**
   * Records a transaction to send. Must be called with the `EntityManager` of the caller's
   * database transaction, so the intent commits or rolls back together with the business
   * data. Enqueueing the same idempotency key again returns the existing entry.
   */
  async enqueue(manager: EntityManager, input: EnqueueInput): Promise<OutboxEntry> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(OutboxEntry)
      .values({
        idempotencyKey: input.idempotencyKey,
        signer: input.signer,
        contract: input.contract,
        method: input.method,
        // jsonb column: TypeORM's partial type cannot express arbitrary JSON values.
        args: () => ':args::jsonb',
      })
      .setParameter('args', JSON.stringify(input.args))
      .orIgnore()
      .execute();
    return manager.findOneByOrFail(OutboxEntry, { idempotencyKey: input.idempotencyKey });
  }

  findById(id: string): Promise<OutboxEntry | null> {
    return this.entries.findOneBy({ id });
  }

  findByKey(idempotencyKey: string): Promise<OutboxEntry | null> {
    return this.entries.findOneBy({ idempotencyKey });
  }
}
