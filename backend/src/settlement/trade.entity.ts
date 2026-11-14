import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A trade reported by the trading venue, with the outbox entries that settle it. */
@Entity({ name: 'trades' })
export class Trade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Trade number assigned by the venue; a trade number is accepted once. */
  @Column({ type: 'text', name: 'trade_no', unique: true })
  tradeNo: string;

  /** keccak256 of the trade number: the trade's identifier on chain. */
  @Column({ type: 'varchar', length: 66, name: 'trade_id' })
  tradeId: string;

  @Column({ type: 'varchar', length: 42 })
  seller: string;

  @Column({ type: 'varchar', length: 42 })
  buyer: string;

  @Column({ type: 'numeric', precision: 78, scale: 0 })
  quantity: string;

  /** Total cash amount in the cash token's smallest unit. */
  @Column({ type: 'numeric', precision: 78, scale: 0 })
  price: string;

  @Column({ type: 'timestamptz' })
  expiry: Date;

  @Column({ type: 'uuid', name: 'create_outbox_id' })
  createOutboxId: string;

  /** Outbox entry of the most recent settlement attempt. */
  @Column({ type: 'uuid', name: 'settle_outbox_id' })
  settleOutboxId: string;

  @Column({ type: 'uuid', name: 'cancel_outbox_id', nullable: true })
  cancelOutboxId: string | null;

  @Column({ type: 'int', name: 'settle_attempts', default: 1 })
  settleAttempts: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
