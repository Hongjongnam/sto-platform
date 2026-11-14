import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { keccak256, type TransactionRequest } from 'ethers';
import { In, Repository } from 'typeorm';
import { ChainService } from '../chain/chain.service.js';
import { OutboxEntry, OutboxStatus } from './outbox.entity.js';

const OPEN = [OutboxStatus.Pending, OutboxStatus.Submitted];

/** The node refused the transaction for a reason that retrying will not change. */
class PermanentBroadcastError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const POLL_INTERVAL_MS = 500;
const GAS_HEADROOM_PERCENT = 130n;

/**
 * Sends outbox entries to the chain.
 *
 * Entries of one signer are processed strictly in insertion order and one at a time, so
 * nonces never collide. An entry is signed, its hash and raw bytes are stored, and only
 * then is it broadcast: after a crash the same signed transaction is looked up or
 * re-broadcast instead of being signed again, which rules out double sends.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @InjectRepository(OutboxEntry) private readonly entries: Repository<OutboxEntry>,
    private readonly chain: ChainService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Advances the oldest open entry of every signer by one step. Returns how many entries are still open. */
  async runOnce(): Promise<number> {
    if (this.running) return -1;
    this.running = true;
    try {
      const heads = await this.entries
        .createQueryBuilder('entry')
        .distinctOn(['entry.signer'])
        .where('entry.status IN (:...open)', { open: OPEN })
        .orderBy('entry.signer')
        .addOrderBy('entry.seq', 'ASC')
        .getMany();
      await Promise.all(heads.map((entry) => this.advance(entry)));
      return this.entries.countBy({ status: In(OPEN) });
    } finally {
      this.running = false;
    }
  }

  /** Runs until nothing is open or `timeoutMs` passes. Intended for tests and scripts. */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const open = await this.runOnce();
      if (open === 0) return;
      if (Date.now() > deadline) throw new Error(`outbox still has ${open} open entries after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async advance(entry: OutboxEntry): Promise<void> {
    try {
      if (entry.status === OutboxStatus.Pending) await this.submit(entry);
      else await this.confirm(entry);
    } catch (error) {
      if (error instanceof PermanentBroadcastError) {
        await this.fail(entry, error.code, error.message);
        return;
      }
      // Infrastructure failure (node or database unreachable): leave the entry as it is and retry.
      await this.entries.update(entry.id, { attempts: entry.attempts + 1 });
      this.logger.warn(`entry ${entry.id} will be retried: ${(error as Error).message}`);
    }
  }

  private async submit(entry: OutboxEntry): Promise<void> {
    if (entry.dependsOn.length > 0) {
      const dependencies = await this.entries.findBy({ id: In(entry.dependsOn) });
      const failed = dependencies.find((dependency) => dependency.status === OutboxStatus.Failed);
      if (failed) {
        await this.fail(entry, 'DEPENDENCY_FAILED', `${failed.contract}.${failed.method}: ${failed.errorCode}`);
        return;
      }
      // Wait until every dependency is confirmed.
      if (dependencies.length < entry.dependsOn.length) return;
      if (dependencies.some((dependency) => dependency.status !== OutboxStatus.Confirmed)) return;
    }

    if (entry.runsAfter.length > 0) {
      const stillOpen = await this.entries.countBy({ id: In(entry.runsAfter), status: In(OPEN) });
      if (stillOpen > 0) return;
    }

    const signer = this.chain.signerFor(entry.signer);
    const contract = this.chain.contract(entry.contract, signer);
    const method = contract.getFunction(entry.method);

    // Simulate first: a call that would revert is failed here with its reason and never sent.
    let gasLimit: bigint;
    try {
      gasLimit = await method.estimateGas(...entry.args);
    } catch (error) {
      const revert = this.chain.decodeRevert(error);
      if (!revert) throw error;
      await this.fail(entry, revert.name, revert.args.join(', '));
      return;
    }

    const request: TransactionRequest = await method.populateTransaction(...entry.args);
    const feeData = await this.chain.provider.getFeeData();
    const nonce = await this.nextNonce(entry.signer);
    request.type = 0;
    request.chainId = BigInt(this.chain.deployment.chainId);
    request.nonce = nonce;
    request.gasLimit = (gasLimit * GAS_HEADROOM_PERCENT) / 100n;
    request.gasPrice = feeData.gasPrice ?? 0n;

    const rawTx = await signer.signTransaction(request);
    const txHash = keccak256(rawTx);
    // Persist before broadcasting.
    await this.entries.update(entry.id, {
      status: OutboxStatus.Submitted,
      txHash,
      rawTx,
      nonce: String(nonce),
      attempts: entry.attempts + 1,
    });
    await this.broadcast(rawTx);
  }

  /**
   * Next nonce for `signer`: the node's pending count, but never lower than one past the
   * highest nonce this outbox has already signed for the signer. The node's view can lag
   * behind a transaction that was just sent.
   */
  private async nextNonce(signer: string): Promise<number> {
    const fromNode = await this.chain.provider.getTransactionCount(signer, 'pending');
    const row = await this.entries
      .createQueryBuilder('entry')
      .select('MAX(entry.nonce)', 'max')
      .where('entry.signer = :signer', { signer })
      // Only nonces that are in flight or were actually used on chain count. An entry that
      // failed without being mined leaves its nonce free; counting it would open a gap.
      .andWhere("(entry.status IN ('SUBMITTED', 'CONFIRMED') OR (entry.status = 'FAILED' AND entry.block_number IS NOT NULL))")
      .getRawOne<{ max: string | null }>();
    const fromOutbox = row?.max == null ? 0 : Number(row.max) + 1;
    return Math.max(fromNode, fromOutbox);
  }

  private async confirm(entry: OutboxEntry): Promise<void> {
    const receipt = await this.chain.provider.getTransactionReceipt(entry.txHash!);
    if (receipt) {
      if (receipt.status === 1) {
        await this.entries.update(entry.id, {
          status: OutboxStatus.Confirmed,
          blockNumber: String(receipt.blockNumber),
        });
      } else {
        await this.fail(entry, 'REVERTED_ON_CHAIN', `transaction ${entry.txHash} reverted`, receipt.blockNumber);
      }
      return;
    }

    // Not mined yet. If the node no longer knows the transaction (for example after a
    // restart before the broadcast went out), send the very same signed bytes again.
    const known = await this.chain.provider.getTransaction(entry.txHash!);
    if (known) return;
    const mined = await this.chain.provider.getTransactionCount(entry.signer, 'latest');
    if (BigInt(mined) > BigInt(entry.nonce!)) {
      await this.fail(entry, 'NONCE_CONSUMED', `nonce ${entry.nonce} was used by another transaction`);
      return;
    }
    await this.broadcast(entry.rawTx!);
  }

  private async broadcast(rawTx: string): Promise<void> {
    try {
      await this.chain.provider.broadcastTransaction(rawTx);
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      // The node already has it; the confirm step will pick it up.
      if (message.includes('already known') || message.includes('known transaction')) return;
      if (message.includes('insufficient funds') || message.includes("doesn't have enough funds")) {
        throw new PermanentBroadcastError('INSUFFICIENT_FUNDS', 'the signer cannot pay for gas');
      }
      throw error;
    }
  }

  private async fail(entry: OutboxEntry, code: string, message: string, blockNumber?: number): Promise<void> {
    await this.entries.update(entry.id, {
      status: OutboxStatus.Failed,
      errorCode: code,
      errorMessage: message.slice(0, 1000),
      blockNumber: blockNumber === undefined ? null : String(blockNumber),
    });
    this.logger.warn(`entry ${entry.id} failed: ${code} ${message}`);
  }
}
