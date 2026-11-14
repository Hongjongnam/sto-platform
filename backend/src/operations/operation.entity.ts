import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const OperationType = {
  Mint: 'MINT',
  Burn: 'BURN',
  Pause: 'PAUSE',
  Unpause: 'UNPAUSE',
  FreezeAddress: 'FREEZE_ADDRESS',
  UnfreezeAddress: 'UNFREEZE_ADDRESS',
  FreezePartial: 'FREEZE_PARTIAL',
  UnfreezePartial: 'UNFREEZE_PARTIAL',
  ForcedTransfer: 'FORCED_TRANSFER',
  Recovery: 'RECOVERY',
  SetRegisteredSupply: 'SET_REGISTERED_SUPPLY',
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

export const ApprovalStatus = {
  PendingApproval: 'PENDING_APPROVAL',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

/** A privileged token operation filed by an operator, with its approval trail. */
@Entity({ name: 'operation_requests' })
export class OperationRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  type: OperationType;

  @Column({ type: 'jsonb' })
  params: Record<string, string>;

  /** Short code recorded on chain as the `reason` of the call. */
  @Column({ type: 'text', name: 'reason_code' })
  reasonCode: string;

  /** Hash of the document that justifies the operation (court order, board resolution, ...). */
  @Column({ type: 'varchar', length: 66, name: 'evidence_hash', nullable: true })
  evidenceHash: string | null;

  @Column({ type: 'text', default: ApprovalStatus.PendingApproval })
  status: ApprovalStatus;

  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy: string;

  @Column({ type: 'uuid', name: 'decided_by', nullable: true })
  decidedBy: string | null;

  @Column({ type: 'text', name: 'decision_note', nullable: true })
  decisionNote: string | null;

  @Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
  decidedAt: Date | null;

  /** Outbox entry that carries the transaction once the request is approved. */
  @Column({ type: 'uuid', name: 'outbox_id', nullable: true })
  outboxId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
