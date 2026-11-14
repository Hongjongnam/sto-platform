import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Investor } from './investor.entity.js';

export const WalletAction = { Register: 'REGISTER', Revoke: 'REVOKE' } as const;
export type WalletAction = (typeof WalletAction)[keyof typeof WalletAction];

/** A custodial wallet of an investor. The key is derived from the key store at `keyIndex`. */
@Entity({ name: 'wallets' })
export class Wallet {
  @PrimaryColumn({ type: 'varchar', length: 42 })
  address: string;

  @ManyToOne(() => Investor, (investor) => investor.wallets, { nullable: false })
  @JoinColumn({ name: 'investor_uuid' })
  investor: Investor;

  @Column({ type: 'uuid', name: 'investor_uuid' })
  investorUuid: string;

  @Column({ type: 'int', name: 'key_index', unique: true })
  keyIndex: number;

  /** Expiry carried by the most recent claim. */
  @Column({ type: 'timestamptz', name: 'kyc_expiry' })
  kycExpiry: Date;

  /** Most recent identity action requested for this wallet and the outbox entry that carries it. */
  @Column({ type: 'text', name: 'last_action' })
  lastAction: WalletAction;

  @Column({ type: 'uuid', name: 'last_outbox_id' })
  lastOutboxId: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
