import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { ContractName } from '../chain/abi.generated.js';

export const OutboxStatus = {
  /** Recorded, not yet signed. */
  Pending: 'PENDING',
  /** Signed and handed to the network; the transaction hash is stored. */
  Submitted: 'SUBMITTED',
  /** Included in a block and succeeded. */
  Confirmed: 'CONFIRMED',
  /** Rejected before sending, or reverted on chain. Never retried automatically. */
  Failed: 'FAILED',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

/** One transaction the system intends to send, written in the same database transaction as the request that caused it. */
@Entity({ name: 'tx_outbox' })
export class OutboxEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Insertion order; entries of one signer are sent strictly in this order. */
  @Column({ type: 'bigint', generated: 'increment', unique: true })
  seq: string;

  /** Caller-chosen key; a second enqueue with the same key returns the first entry. */
  @Column({ type: 'text', name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 42 })
  signer: string;

  @Column({ type: 'text' })
  contract: ContractName;

  @Column({ type: 'text' })
  method: string;

  /** JSON-encoded call arguments; integers are decimal strings. */
  @Column({ type: 'jsonb' })
  args: unknown[];

  /**
   * Entries that must be confirmed before this one is sent. Entries of different signers
   * are otherwise sent independently, so a call that relies on another signer's
   * transaction (a settlement on the parties' approvals) names it here.
   */
  @Column({ type: 'uuid', array: true, name: 'depends_on', default: () => "'{}'" })
  dependsOn: string[];

  /**
   * Entries that must have finished, successfully or not, before this one is sent. Used to
   * keep two flows that touch the same on-chain state (for example one party's allowance)
   * from interleaving.
   */
  @Column({ type: 'uuid', array: true, name: 'runs_after', default: () => "'{}'" })
  runsAfter: string[];

  @Column({ type: 'text', default: OutboxStatus.Pending })
  status: OutboxStatus;

  @Column({ type: 'varchar', length: 66, name: 'tx_hash', nullable: true })
  txHash: string | null;

  @Column({ type: 'bigint', nullable: true })
  nonce: string | null;

  /** Signed transaction, kept so the exact same transaction can be re-broadcast after a restart. */
  @Column({ type: 'text', name: 'raw_tx', nullable: true })
  rawTx: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'bigint', name: 'block_number', nullable: true })
  blockNumber: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
