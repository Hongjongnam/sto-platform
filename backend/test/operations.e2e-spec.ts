import type { INestApplication } from '@nestjs/common';
import { id as keccakId } from 'ethers';
import request from 'supertest';
import { ChainService } from '../src/chain/chain.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';
import { operatorTokens } from './setup/operators.js';

const EVIDENCE = keccakId('court-order-2027-001.pdf');

describe('operations', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let chain: ChainService;
  let tokens: Awaited<ReturnType<typeof operatorTokens>>;
  let alice: string;
  let bob: string;

  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => http.get(path).set(auth),
      post: (path: string, body?: object) => http.post(path).set(auth).send(body ?? {}),
    };
  };
  const token = () => chain.contract('SecurityToken');
  const file = (as: string, body: object) => api(as).post('/operations', body);

  async function onboard(name: string): Promise<string> {
    const created = await api(tokens.requester).post('/investors', { name, country: 410, investorType: 0 });
    return created.body.wallets[0].address;
  }

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    chain = app.get(ChainService);
    tokens = await operatorTokens(app);
    alice = await onboard('Alice');
    bob = await onboard('Bob');
    await worker.drain();

    // Raising the registered supply needs approval; do it once for the whole suite.
    const supply = await file(tokens.requester, {
      type: 'SET_REGISTERED_SUPPLY',
      params: { amount: '1000000' },
      reasonCode: 'INITIAL_REGISTRATION',
      evidenceHash: EVIDENCE,
    });
    await api(tokens.approver).post(`/operations/${supply.body.id}/approve`);
    await worker.drain();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends an operation that needs no approval straight away', async () => {
    const created = await file(tokens.requester, { type: 'MINT', params: { to: alice, amount: '500' }, reasonCode: 'PRIMARY_ISSUANCE' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'APPROVED', needsApproval: false, decisionNote: 'AUTO' });
    expect(created.body.execution.status).toBe('PENDING');

    await worker.drain();

    const done = await api(tokens.viewer).get(`/operations/${created.body.id}`);
    expect(done.body.execution.status).toBe('CONFIRMED');
    expect(done.body.execution.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await token().balanceOf(alice)).toBe(500n);
  });

  it('holds an enforcement operation until a different operator approves it', async () => {
    const created = await file(tokens.requester, {
      type: 'FREEZE_PARTIAL',
      params: { account: alice, amount: '200' },
      reasonCode: 'COURT_ORDER',
      evidenceHash: EVIDENCE,
    });
    expect(created.body).toMatchObject({ status: 'PENDING_APPROVAL', needsApproval: true, execution: null });

    await worker.drain();
    expect(await token().getFrozenTokens(alice)).toBe(0n);

    const approved = await api(tokens.approver).post(`/operations/${created.body.id}/approve`, { note: 'checked against the order' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', decisionNote: 'checked against the order' });
    expect(approved.body.decidedBy).not.toBe(approved.body.requestedBy);

    await worker.drain();
    expect(await token().getFrozenTokens(alice)).toBe(200n);
  });

  it('does not let the operator who filed a request approve or reject it', async () => {
    // This operator holds both roles.
    const created = await file(tokens.secondApprover, {
      type: 'FREEZE_ADDRESS',
      params: { account: bob },
      reasonCode: 'COURT_ORDER',
      evidenceHash: EVIDENCE,
    });
    const selfApprove = await api(tokens.secondApprover).post(`/operations/${created.body.id}/approve`);
    expect(selfApprove.status).toBe(403);
    const selfReject = await api(tokens.secondApprover).post(`/operations/${created.body.id}/reject`, { note: 'changed my mind' });
    expect(selfReject.status).toBe(403);

    await worker.drain();
    expect(await token().isFrozen(bob)).toBe(false);
    expect((await api(tokens.viewer).get(`/operations/${created.body.id}`)).body.status).toBe('PENDING_APPROVAL');
  });

  it('rejects a request without sending anything, and a decision is final', async () => {
    const created = await file(tokens.requester, {
      type: 'FORCED_TRANSFER',
      params: { from: alice, to: bob, amount: '100' },
      reasonCode: 'COURT_ORDER',
      evidenceHash: EVIDENCE,
    });
    const rejected = await api(tokens.approver).post(`/operations/${created.body.id}/reject`, { note: 'order does not name this account' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', execution: null });

    await worker.drain();
    expect(await token().balanceOf(bob)).toBe(0n);

    expect((await api(tokens.approver).post(`/operations/${created.body.id}/approve`)).status).toBe(409);
    expect((await api(tokens.secondApprover).post(`/operations/${created.body.id}/reject`, { note: 'again' })).status).toBe(409);
    expect((await api(tokens.approver).post(`/operations/${created.body.id}/reject`, {})).status).toBe(400);
  });

  it('executes a forced transfer once approved and records the reason on chain', async () => {
    const created = await file(tokens.requester, {
      type: 'FORCED_TRANSFER',
      params: { from: alice, to: bob, amount: '350' },
      reasonCode: 'COURT_ORDER',
      evidenceHash: EVIDENCE,
    });
    await api(tokens.secondApprover).post(`/operations/${created.body.id}/approve`);
    await worker.drain();

    // 300 free + 50 released from the frozen 200.
    expect(await token().balanceOf(bob)).toBe(350n);
    expect(await token().balanceOf(alice)).toBe(150n);
    expect(await token().getFrozenTokens(alice)).toBe(150n);

    const done = await api(tokens.viewer).get(`/operations/${created.body.id}`);
    const receipt = await chain.provider.getTransactionReceipt(done.body.execution.txHash);
    const forced = receipt!.logs
      .map((log) => token().interface.parseLog(log))
      .find((parsed) => parsed?.name === 'ForcedTransfer');
    expect(forced?.args.reason).toBe('0x434f5552545f4f52444552000000000000000000000000000000000000000000');
    expect(forced?.args.operator).toBe(chain.deployment.roles.enforcer);
  });

  it('reports why an approved operation failed on chain', async () => {
    const outsider = chain.keys.derive(150).address;
    const created = await file(tokens.requester, { type: 'MINT', params: { to: outsider, amount: '1' }, reasonCode: 'PRIMARY_ISSUANCE' });
    await worker.drain();
    const done = await api(tokens.viewer).get(`/operations/${created.body.id}`);
    expect(done.body.status).toBe('APPROVED');
    expect(done.body.execution).toMatchObject({ status: 'FAILED', errorCode: 'NotVerified', txHash: null });
  });

  it('requires supporting evidence for operations that need approval', async () => {
    const missing = await file(tokens.requester, { type: 'FREEZE_ADDRESS', params: { account: bob }, reasonCode: 'COURT_ORDER' });
    expect(missing.status).toBe(400);
    const malformed = await file(tokens.requester, {
      type: 'FREEZE_ADDRESS',
      params: { account: bob },
      reasonCode: 'COURT_ORDER',
      evidenceHash: '0x1234',
    });
    expect(malformed.status).toBe(400);
  });

  it('validates the type, parameters and reason code', async () => {
    const base = { reasonCode: 'TEST' };
    expect((await file(tokens.requester, { ...base, type: 'SELF_DESTRUCT', params: {} })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: alice } })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: alice, amount: '0' } })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: alice, amount: '-5' } })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: alice, amount: 5 } })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: 'alice', amount: '5' } })).status).toBe(400);
    expect((await file(tokens.requester, { ...base, type: 'MINT', params: { to: alice, amount: '5', extra: 'x' } })).status).toBe(400);
    expect((await file(tokens.requester, { type: 'MINT', params: { to: alice, amount: '5' }, reasonCode: 'lower case reason' })).status).toBe(400);
    expect((await api(tokens.viewer).get('/operations/not-a-uuid')).status).toBe(400);
    expect((await api(tokens.viewer).get('/operations/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('enforces roles on filing and deciding', async () => {
    const body = { type: 'MINT', params: { to: alice, amount: '1' }, reasonCode: 'TEST' };
    expect((await file(tokens.viewer, body)).status).toBe(403);
    expect((await file(tokens.approver, body)).status).toBe(403);

    const pending = await file(tokens.requester, {
      type: 'FREEZE_ADDRESS',
      params: { account: bob },
      reasonCode: 'COURT_ORDER',
      evidenceHash: EVIDENCE,
    });
    expect((await api(tokens.requester).post(`/operations/${pending.body.id}/approve`)).status).toBe(403);
    expect((await api(tokens.viewer).post(`/operations/${pending.body.id}/approve`)).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/operations')).status).toBe(401);
  });

  it('lists requests and filters by status', async () => {
    const all = await api(tokens.viewer).get('/operations');
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThanOrEqual(6);
    const pending = await api(tokens.viewer).get('/operations?status=PENDING_APPROVAL');
    expect(pending.body.length).toBeGreaterThanOrEqual(2);
    expect(pending.body.every((item: { status: string }) => item.status === 'PENDING_APPROVAL')).toBe(true);
    expect((await api(tokens.viewer).get('/operations?status=NOPE')).status).toBe(400);
  });
});
