import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ChainService } from '../src/chain/chain.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';
import { operatorTokens } from './setup/operators.js';

describe('investors', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let chain: ChainService;
  let tokens: Awaited<ReturnType<typeof operatorTokens>>;

  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => http.get(path).set(auth),
      post: (path: string, body?: object) => http.post(path).set(auth).send(body),
    };
  };
  const registry = () => chain.contract('IdentityRegistry');

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    chain = app.get(ChainService);
    tokens = await operatorTokens(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('onboards an investor: creates a wallet and registers a signed claim on chain', async () => {
    const created = await api(tokens.requester).post('/investors', { name: 'Kim', country: 410, investorType: 1 });
    expect(created.status).toBe(201);
    expect(created.body.wallets).toHaveLength(1);
    expect(created.body.wallets[0].kycStatus).toBe('PENDING');
    const wallet = created.body.wallets[0].address as string;
    expect(await registry().isVerified(wallet)).toBe(false);

    await worker.drain();

    const fetched = await api(tokens.viewer).get(`/investors/${created.body.id}`);
    expect(fetched.body.wallets[0].kycStatus).toBe('VERIFIED');
    expect(await registry().isVerified(wallet)).toBe(true);
    expect(await registry().investorOf(wallet)).toBe(created.body.investorId);
    expect(await registry().investorTypeOf(wallet)).toBe(1n);
    expect(await registry().countryOf(wallet)).toBe(410n);
  });

  it('links a second wallet to the same on-chain investor', async () => {
    const created = await api(tokens.requester).post('/investors', { name: 'Lee', country: 410, investorType: 0 });
    const withSecond = await api(tokens.requester).post(`/investors/${created.body.id}/wallets`);
    expect(withSecond.body.wallets).toHaveLength(2);
    await worker.drain();

    const [first, second] = withSecond.body.wallets.map((wallet: { address: string }) => wallet.address);
    expect(first).not.toBe(second);
    expect(await registry().investorOf(first)).toBe(await registry().investorOf(second));
    expect(await registry().isVerified(second)).toBe(true);
  });

  it('revokes and renews a wallet', async () => {
    const created = await api(tokens.requester).post('/investors', { name: 'Park', country: 410, investorType: 0 });
    const wallet = created.body.wallets[0].address as string;
    await worker.drain();

    const revoked = await api(tokens.requester).post(`/wallets/${wallet}/revoke`, { reason: 'KYC_WITHDRAWN' });
    expect(revoked.status).toBe(201);
    await worker.drain();
    expect(await registry().isVerified(wallet)).toBe(false);
    expect((await api(tokens.viewer).get(`/investors/${created.body.id}`)).body.wallets[0].kycStatus).toBe('REVOKED');

    await api(tokens.requester).post(`/wallets/${wallet}/renew`);
    await worker.drain();
    expect(await registry().isVerified(wallet)).toBe(true);
    expect((await api(tokens.viewer).get(`/investors/${created.body.id}`)).body.wallets[0].kycStatus).toBe('VERIFIED');
    // The original investor link survives revocation and renewal.
    expect(await registry().investorOf(wallet)).toBe(created.body.investorId);
  });

  it('refuses a second identity action while the first is still in flight', async () => {
    const created = await api(tokens.requester).post('/investors', { name: 'Choi', country: 410, investorType: 0 });
    const wallet = created.body.wallets[0].address as string;
    const tooEarly = await api(tokens.requester).post(`/wallets/${wallet}/revoke`, { reason: 'KYC_WITHDRAWN' });
    expect(tooEarly.status).toBe(409);
    await worker.drain();
    expect(await registry().isVerified(wallet)).toBe(true);
  });

  it('lists investors and returns 404 for unknown ones', async () => {
    const list = await api(tokens.viewer).get('/investors');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(4);
    expect(list.body[0]).toHaveProperty('wallets');
    expect((await api(tokens.viewer).get('/investors/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await api(tokens.requester).post('/wallets/0x0000000000000000000000000000000000000001/renew')).status).toBe(404);
  });

  it('validates input', async () => {
    const post = (body: object) => api(tokens.requester).post('/investors', body);
    expect((await post({ name: '', country: 410, investorType: 0 })).status).toBe(400);
    expect((await post({ name: 'X', country: 410, investorType: 3 })).status).toBe(400);
    expect((await post({ name: 'X', country: 0, investorType: 0 })).status).toBe(400);
    expect((await api(tokens.viewer).get('/investors/not-a-uuid')).status).toBe(400);
    expect((await api(tokens.requester).post('/wallets/not-an-address/renew')).status).toBe(400);
    const created = await api(tokens.requester).post('/investors', { name: 'Jung', country: 410, investorType: 0 });
    await worker.drain();
    const badReason = await api(tokens.requester).post(`/wallets/${created.body.wallets[0].address}/revoke`, { reason: 'lower case' });
    expect(badReason.status).toBe(400);
  });

  it('lets only requesters change investors', async () => {
    expect((await api(tokens.viewer).post('/investors', { name: 'X', country: 410, investorType: 0 })).status).toBe(403);
    expect((await api(tokens.approver).post('/investors', { name: 'X', country: 410, investorType: 0 })).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/investors')).status).toBe(401);
  });
});
