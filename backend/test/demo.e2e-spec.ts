import { type INestApplication, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { id as keccakId } from 'ethers';
import request from 'supertest';
import { ChainService } from '../src/chain/chain.service.js';
import type { Env } from '../src/config/env.js';
import { DemoController } from '../src/demo/demo.controller.js';
import { IndexerService } from '../src/ledger/indexer.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';

describe('demo mode and investor wallet', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let chain: ChainService;
  let requester: string;
  let approver: string;
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

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    chain = app.get(ChainService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs a visitor in as two different operators without credentials', async () => {
    expect((await request(app.getHttpServer()).get('/demo/status')).body).toEqual({ enabled: true });
    const session = await request(app.getHttpServer()).post('/demo/session');
    expect(session.status).toBe(200);
    requester = session.body.requester.accessToken;
    approver = session.body.approver.accessToken;

    const asRequester = await api(requester).get('/auth/me');
    const asApprover = await api(approver).get('/auth/me');
    expect(asRequester.body.roles).toEqual(['REQUESTER']);
    expect(asApprover.body.roles).toEqual(['APPROVER']);
    expect(asRequester.body.id).not.toBe(asApprover.body.id);
  });

  it('lets the two demo operators complete a four-eyes operation together', async () => {
    const a = await api(requester).post('/investors', { name: 'Demo Alice', country: 410, investorType: 0 });
    const b = await api(requester).post('/investors', { name: 'Demo Bob', country: 410, investorType: 0 });
    alice = a.body.wallets[0].address;
    bob = b.body.wallets[0].address;
    await worker.drain();

    const supply = await api(requester).post('/operations', {
      type: 'SET_REGISTERED_SUPPLY',
      params: { amount: '9500000' },
      reasonCode: 'REGISTRATION',
      evidenceHash: keccakId('registration.pdf'),
    });
    expect((await api(requester).post(`/operations/${supply.body.id}/approve`)).status).toBe(403);
    expect((await api(approver).post(`/operations/${supply.body.id}/approve`)).status).toBe(200);
    // Issuance is capped by the registered supply, so let that confirm first.
    await worker.drain();
    await api(requester).post('/operations', { type: 'MINT', params: { to: alice, amount: '120' }, reasonCode: 'PRIMARY_ISSUANCE' });
    await worker.drain();
    expect(await chain.contract('SecurityToken').balanceOf(alice)).toBe(120n);
  });

  it("shows a wallet's balances and lets the wallet transfer", async () => {
    const before = await api(requester).get(`/wallets/${alice}/portfolio`);
    expect(before.body).toMatchObject({ balance: '120', frozen: '0', free: '120', addressFrozen: false, verified: true });

    const sent = await api(requester).post(`/wallets/${alice}/transfers`, { to: bob, amount: '20' });
    expect(sent.status).toBe(201);
    await worker.drain();
    const done = await api(requester).get(`/transactions/${sent.body.transactionId}`);
    expect(done.body).toMatchObject({ status: 'CONFIRMED', contract: 'SecurityToken', method: 'transfer', signer: alice });
    expect((await api(requester).get(`/wallets/${bob}/portfolio`)).body.balance).toBe('20');
  });

  it('reports why a transfer was rejected', async () => {
    const outsider = chain.keys.derive(240).address;
    const sent = await api(requester).post(`/wallets/${alice}/transfers`, { to: outsider, amount: '1' });
    await worker.drain();
    const done = await api(requester).get(`/transactions/${sent.body.transactionId}`);
    expect(done.body).toMatchObject({ status: 'FAILED', errorCode: 'NotVerified', txHash: null });

    expect((await api(requester).post(`/wallets/${outsider}/transfers`, { to: bob, amount: '1' })).status).toBe(404);
    expect((await api(requester).get(`/wallets/${outsider}/portfolio`)).status).toBe(404);
    expect((await api(requester).get('/transactions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await api(approver).post(`/wallets/${alice}/transfers`, { to: bob, amount: '1' })).status).toBe(403);
  });

  it('corrupts the ledger on request so reconciliation has something to find', async () => {
    await app.get(IndexerService).syncToHead();
    expect((await api(requester).post('/recon/run')).body.ok).toBe(true);

    const corrupted = await api(requester).post('/demo/ledger/corrupt');
    expect(corrupted.status).toBe(200);
    expect(corrupted.body.addedToLedger).toBe('7');

    const broken = await api(requester).post('/recon/run');
    expect(broken.body.ok).toBe(false);
    expect(broken.body.mismatches.some((m: { field: string; subject?: string }) => m.field === 'balance' && m.subject === corrupted.body.wallet)).toBe(true);

    await api(approver).post('/recon/rebuild');
    expect((await api(requester).post('/recon/run')).body.ok).toBe(true);
    expect((await request(app.getHttpServer()).post('/demo/ledger/corrupt')).status).toBe(401);
  });
});

describe('demo mode off', () => {
  it('hides the demo endpoints', async () => {
    const config = { get: () => 'off' } as unknown as ConfigService<Env, true>;
    const controller = new DemoController(config, undefined as never, undefined as never);
    expect(controller.status()).toEqual({ enabled: false });
    await expect(controller.session()).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.corruptLedger()).rejects.toBeInstanceOf(NotFoundException);
  });
});
