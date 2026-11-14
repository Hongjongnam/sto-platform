import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const OperatorRole = {
  /** Read-only access. */
  Viewer: 'VIEWER',
  /** Can file requests for operations. */
  Requester: 'REQUESTER',
  /** Can approve or reject requests filed by someone else. */
  Approver: 'APPROVER',
} as const;
export type OperatorRole = (typeof OperatorRole)[keyof typeof OperatorRole];

/** A person who uses the back office. Operators act through requests; they never hold chain keys. */
@Entity({ name: 'operators' })
export class Operator {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  username: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName: string;

  @Column({ type: 'text', name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'text', array: true })
  roles: OperatorRole[];

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
