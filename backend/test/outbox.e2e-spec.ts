import type { INestApplication } from '@nestjs/common';
import { encodeBytes32String } from 'ethers';
import { DataSource } from 'typeorm';
import { ChainService } from '../src/chain/chain.service.js';
import { OutboxEntry, OutboxStatus } from '../src/outbox/outbox.entity.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';

const REASON = encodeBytes32String('TEST');

describe('outbox', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let outbox: OutboxService;
  let worker: OutboxWorker;
  let chain: ChainService;
  let registrar: string;
  let issuer: string;

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
    outbox = app.get(OutboxService);
    worker = app.get(OutboxWorker);
    chain = app.get(ChainService);
    registrar = chain.deployment.roles.registrar;
    issuer = chain.deployment.roles.issuer;
  });

  afterAll(async () => {
    await app.close();
  });

  const enqueue = (input: Parameters<OutboxService['enqueue']>[1]) =>
    dataSource.transaction((manager) => outbox.enqueue(manager, input));

  const setSupply = (key: string, amount: string) =>
    enqueue({ idempotencyKey: key, signer: registrar, contract: 'SecurityToken', method: 'setRegisteredSupply', args: [amount, REASON] });

  it('sends a recorded transaction and marks it confirmed', async () => {
    const entry = await setSupply('supply:1', '1000000');
    expect(entry.status).toBe(OutboxStatus.Pending);

    await worker.drain();

    const done = await outbox.findById(entry.id);
    expect(done?.status).toBe(OutboxStatus.Confirmed);
    expect(done?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(done?.blockNumber)).toBeGreaterThan(0);
    expect(await chain.contract('SecurityToken').registeredSupply()).toBe(1_000_000n);
  });

  it('fails a transaction that would revert, with the decoded reason, without sending it', async () => {
    const nonceBefore = await chain.provider.getTransactionCount(issuer);
    const outsider = chain.keys.derive(40).address;
    const entry = await enqueue({
      idempotencyKey: 'mint:unverified',
      signer: issuer,
      contract: 'SecurityToken',
      method: 'mint',
      args: [outsider, '1', REASON],
    });

    await worker.drain();

    const done = await outbox.findById(entry.id);
    expect(done?.status).toBe(OutboxStatus.Failed);
    expect(done?.errorCode).toBe('NotVerified');
    expect(done?.errorMessage).toContain(outsider);
    expect(done?.txHash).toBeNull();
    expect(await chain.provider.getTransactionCount(issuer)).toBe(nonceBefore);
  });

  it('returns the existing entry when the same idempotency key is enqueued again', async () => {
    const first = await setSupply('supply:idempotent', '1000001');
    const second = await setSupply('supply:idempotent', '9999999');
    expect(second.id).toBe(first.id);
    expect(second.args).toEqual(['1000001', REASON]);

    await worker.drain();
    expect(await chain.contract('SecurityToken').registeredSupply()).toBe(1_000_001n);
    expect(await dataSource.getRepository(OutboxEntry).countBy({ idempotencyKey: 'supply:idempotent' })).toBe(1);
  });

  it('does not record anything when the surrounding database transaction rolls back', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await outbox.enqueue(manager, {
          idempotencyKey: 'supply:rolled-back',
          signer: registrar,
          contract: 'SecurityToken',
          method: 'setRegisteredSupply',
          args: ['5', REASON],
        });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await outbox.findByKey('supply:rolled-back')).toBeNull();
  });

  it('sends the entries of one signer in order with consecutive nonces', async () => {
    const entries = [];
    for (const amount of ['1000010', '1000020', '1000030']) entries.push(await setSupply(`supply:order:${amount}`, amount));

    await worker.drain();

    const done = await Promise.all(entries.map((entry) => outbox.findById(entry.id)));
    expect(done.map((entry) => entry?.status)).toEqual(Array(3).fill(OutboxStatus.Confirmed));
    const nonces = done.map((entry) => Number(entry?.nonce));
    expect(nonces).toEqual([nonces[0], nonces[0] + 1, nonces[0] + 2]);
    expect(await chain.contract('SecurityToken').registeredSupply()).toBe(1_000_030n);
  });

  it('does not let a failed entry block the entries behind it', async () => {
    const before = await setSupply('supply:before-failure', '1500000');
    // The registrar does not hold the pauser role, so this one is rejected.
    const rejected = await enqueue({
      idempotencyKey: 'pause:not-pauser',
      signer: registrar,
      contract: 'SecurityToken',
      method: 'pause',
      args: [REASON],
    });
    const after = await setSupply('supply:after-failure', '2000000');

    await worker.drain();

    expect((await outbox.findById(before.id))?.status).toBe(OutboxStatus.Confirmed);
    const failed = await outbox.findById(rejected.id);
    expect(failed?.status).toBe(OutboxStatus.Failed);
    expect(failed?.errorCode).toBe('AccessControlUnauthorizedAccount');
    expect((await outbox.findById(after.id))?.status).toBe(OutboxStatus.Confirmed);
    expect(await chain.contract('SecurityToken').registeredSupply()).toBe(2_000_000n);
  });

  it('re-broadcasts the same signed transaction after a crash between persisting and sending', async () => {
    const nonceBefore = await chain.provider.getTransactionCount(registrar);
    const entry = await setSupply('supply:crash', '3000000');

    // The process dies right after the signed transaction was stored.
    const broadcast = vi.spyOn(chain.provider, 'broadcastTransaction').mockRejectedValueOnce(new Error('connection lost'));
    await worker.runOnce();
    broadcast.mockRestore();

    const stored = await outbox.findById(entry.id);
    expect(stored?.status).toBe(OutboxStatus.Submitted);
    expect(await chain.provider.getTransactionReceipt(stored!.txHash!)).toBeNull();

    // After the restart the worker finds the entry and sends the stored bytes.
    await worker.drain();

    const done = await outbox.findById(entry.id);
    expect(done?.status).toBe(OutboxStatus.Confirmed);
    expect(done?.txHash).toBe(stored?.txHash);
    expect(await chain.provider.getTransactionCount(registrar)).toBe(nonceBefore + 1);
    expect(await chain.contract('SecurityToken').registeredSupply()).toBe(3_000_000n);
  });
});
