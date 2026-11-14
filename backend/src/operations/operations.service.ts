import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { encodeBytes32String } from 'ethers';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { OutboxEntry } from '../outbox/outbox.entity.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { OPERATIONS, paramsSchemas } from './operation.catalog.js';
import { ApprovalStatus, OperationRequest, type OperationType } from './operation.entity.js';

const AUTO_NOTE = 'AUTO';

export interface OperationView {
  id: string;
  type: OperationType;
  params: Record<string, string>;
  reasonCode: string;
  evidenceHash: string | null;
  status: ApprovalStatus;
  needsApproval: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** Progress of the transaction once approved; null while waiting or after rejection. */
  execution: {
    status: string;
    txHash: string | null;
    blockNumber: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly outbox: OutboxService,
    @InjectRepository(OperationRequest) private readonly requests: Repository<OperationRequest>,
    @InjectRepository(OutboxEntry) private readonly entries: Repository<OutboxEntry>,
  ) {}

  /**
   * Files an operation. Operations that do not need approval are sent to the chain right
   * away; the others wait for a second operator.
   */
  async create(
    operatorId: string,
    input: { type: OperationType; params: unknown; reasonCode: string; evidenceHash?: string },
  ): Promise<OperationView> {
    const parsed = paramsSchemas[input.type].safeParse(input.params);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => `params.${issue.path.join('.')}: ${issue.message}`));
    }
    const spec = OPERATIONS[input.type];
    if (spec.needsApproval && !input.evidenceHash) {
      throw new BadRequestException('evidenceHash is required for operations that need approval');
    }

    const id = await this.dataSource.transaction(async (manager) => {
      const request = manager.create(OperationRequest, {
        type: input.type,
        params: parsed.data as Record<string, string>,
        reasonCode: input.reasonCode,
        evidenceHash: input.evidenceHash ?? null,
        requestedBy: operatorId,
      });
      await manager.save(request);
      if (!spec.needsApproval) {
        request.decisionNote = AUTO_NOTE;
        await this.approveIn(manager, request, operatorId);
      }
      return request.id;
    });
    return this.get(id);
  }

  /** Approves a pending request and hands its transaction to the outbox. */
  async approve(operatorId: string, id: string, note?: string): Promise<OperationView> {
    await this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, id, operatorId);
      request.decisionNote = note ?? null;
      await this.approveIn(manager, request, operatorId);
    });
    return this.get(id);
  }

  /** Rejects a pending request. Nothing is sent. */
  async reject(operatorId: string, id: string, note: string): Promise<OperationView> {
    await this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, id, operatorId);
      request.status = ApprovalStatus.Rejected;
      request.decidedBy = operatorId;
      request.decisionNote = note;
      request.decidedAt = new Date();
      await manager.save(request);
    });
    return this.get(id);
  }

  async list(status?: ApprovalStatus): Promise<OperationView[]> {
    const requests = await this.requests.find({ where: status ? { status } : {}, order: { createdAt: 'DESC' }, take: 200 });
    return this.toViews(requests);
  }

  async get(id: string): Promise<OperationView> {
    const request = await this.requests.findOneBy({ id });
    if (!request) throw new NotFoundException('Operation request not found');
    return (await this.toViews([request]))[0];
  }

  private async approveIn(manager: EntityManager, request: OperationRequest, operatorId: string): Promise<void> {
    const spec = OPERATIONS[request.type];
    const entry = await this.outbox.enqueue(manager, {
      idempotencyKey: `operation:${request.id}`,
      signer: this.chain.deployment.roles[spec.signer],
      contract: spec.contract,
      method: spec.method,
      args: spec.args(request.params, encodeBytes32String(request.reasonCode)),
    });
    request.status = ApprovalStatus.Approved;
    request.decidedBy = operatorId;
    request.decidedAt = new Date();
    request.outboxId = entry.id;
    await manager.save(request);
  }

  /** Loads a request for a decision: it must be pending and filed by someone else. */
  private async lockPending(manager: EntityManager, id: string, operatorId: string): Promise<OperationRequest> {
    const request = await manager.findOne(OperationRequest, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!request) throw new NotFoundException('Operation request not found');
    if (request.status !== ApprovalStatus.PendingApproval) {
      throw new ConflictException(`The request was already ${request.status.toLowerCase()}`);
    }
    if (request.requestedBy === operatorId) {
      throw new ForbiddenException('A request cannot be decided by the operator who filed it');
    }
    return request;
  }

  private async toViews(requests: OperationRequest[]): Promise<OperationView[]> {
    const outboxIds = requests.map((request) => request.outboxId).filter((id): id is string => id !== null);
    const entries = outboxIds.length ? await this.entries.findBy({ id: In(outboxIds) }) : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return requests.map((request) => {
      const entry = request.outboxId ? byId.get(request.outboxId) : undefined;
      return {
        id: request.id,
        type: request.type,
        params: request.params,
        reasonCode: request.reasonCode,
        evidenceHash: request.evidenceHash,
        status: request.status,
        needsApproval: OPERATIONS[request.type].needsApproval,
        requestedBy: request.requestedBy,
        decidedBy: request.decidedBy,
        decisionNote: request.decisionNote,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        createdAt: request.createdAt.toISOString(),
        execution: entry
          ? {
              status: entry.status,
              txHash: entry.txHash,
              blockNumber: entry.blockNumber,
              errorCode: entry.errorCode,
              errorMessage: entry.errorMessage,
            }
          : null,
      };
    });
  }
}
