import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Wallet } from './wallet.entity.js';

/** Investor categories, matching `IdentityRegistry.InvestorType`. */
export const InvestorType = { Retail: 0, Qualified: 1, Professional: 2 } as const;

/** An investor known to the back office. Personal data stays here; only `investorId` goes on chain. */
@Entity({ name: 'investors' })
export class Investor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Opaque on-chain identifier: keccak256 of the internal id. */
  @Column({ type: 'varchar', length: 66, name: 'investor_id', unique: true })
  investorId: string;

  @Column({ type: 'text' })
  name: string;

  /** ISO 3166-1 numeric code. */
  @Column({ type: 'int' })
  country: number;

  @Column({ type: 'int', name: 'investor_type' })
  investorType: number;

  @OneToMany(() => Wallet, (wallet) => wallet.investor)
  wallets: Wallet[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
