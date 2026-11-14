import type { INestApplication } from '@nestjs/common';
import { id as keccakId } from 'ethers';
import request from 'supertest';
import { ChainService } from '../src/chain/chain.service.js';
import { IndexerService } from '../src/ledger/indexer.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';
import { operatorTokens } from './setup/operators.js';

const EVIDENCE = keccakId('evidence.pdf');
const UNIT = 1_000_000n;

describe('settlement', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let indexer: IndexerService;
  let chain: ChainService;
  let tokens: Awaited<ReturnType<typeof operatorTokens>>;
  let seller: string;
  let buyer: string;
  let tradeSeq = 0;

  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => http.get(path).set(auth),
      post: (path: string, body?: object) => http.post(path).set(auth).send(body ?? {}),
    };
  };
  const security = () => chain.contract('SecurityToken');
  const cash = () => chain.contract('USDC');
  const nextTradeNo = () => `TEST-${Date.now()}-${++tradeSeq}`;
  const report = (overrides: object = {}) =>
    api(tokens.requester).post('/trades', {
      tradeNo: nextTradeNo(),
      seller,
      buyer,
      quantity: '10',
      price: (1_000n * UNIT).toString(),
      ...overrides,
    });
  const trade = async (id: string) => (await api(tokens.viewer).get(`/trades/${id}`)).body;

  async function operate(type: string, params: object): Promise<void> {
    const created = await api(tokens.requester).post('/operations', { type, params, reasonCode: 'TEST', evidenceHash: EVIDENCE });
    if (created.body.needsApproval) await api(tokens.approver).post(`/operations/${created.body.id}/approve`);
    await worker.drain();
  }

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    indexer = app.get(IndexerService);
    chain = app.get(ChainService);
    tokens = await operatorTokens(app);

    const s = await api(tokens.requester).post('/investors', { name: 'Seller', country: 410, investorType: 0 });
    const b = await api(tokens.requester).post('/investors', { name: 'Buyer', country: 410, investorType: 0 });
    seller = s.body.wallets[0].address;
    buyer = b.body.wallets[0].address;
    await worker.drain();
    await operate('SET_REGISTERED_SUPPLY', { amount: '9000000' });
    await operate('MINT', { to: seller, amount: '500' });
    const funded = await api(tokens.requester).post(`/wallets/${buyer}/cash`, { amount: (50_000n * UNIT).toString() });
    expect(funded.status).toBe(201);
    await worker.drain();
  });

  afterAll(async () => {
    await app.close();
  });

  it('settles a reported trade: securities to the buyer, cash to the seller', async () => {
    const created = await report();
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.tradeId).toBe(keccakId(created.body.tradeNo));

    await worker.drain();

    const settled = await trade(created.body.id);
    expect(settled.status).toBe('SETTLED');
    expect(settled.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await security().balanceOf(buyer)).toBe(10n);
    expect(await security().balanceOf(seller)).toBe(490n);
    expect(await cash().balanceOf(seller)).toBe(1_000n * UNIT);

    // Both legs moved in the same transaction.
    const receipt = await chain.provider.getTransactionReceipt(settled.txHash);
    const transfers = receipt!.logs.filter((log) => log.topics[0] === keccakId('Transfer(address,address,uint256)'));
    expect(transfers.map((log) => log.address).sort()).toEqual([chain.addressOf('SecurityToken'), chain.addressOf('USDC')].sort());
  });

  it('accepts a trade number only once', async () => {
    const tradeNo = nextTradeNo();
    const first = await report({ tradeNo });
    const second = await report({ tradeNo, quantity: '99' });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.quantity).toBe('10');

    await worker.drain();
    expect(await security().balanceOf(buyer)).toBe(20n);
    const listed = (await api(tokens.viewer).get('/trades')).body.filter((item: { tradeNo: string }) => item.tradeNo === tradeNo);
    expect(listed).toHaveLength(1);
  });

  it('moves neither leg when the buyer cannot pay, and settles on retry once funded', async () => {
    const sellerCash = await cash().balanceOf(seller);
    const created = await report({ quantity: '5', price: (900_000n * UNIT).toString() });
    await worker.drain();

    const failed = await trade(created.body.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.failure).toMatchObject({ step: 'settle', errorCode: 'ERC20InsufficientBalance' });
    expect(await security().balanceOf(buyer)).toBe(20n);
    expect(await cash().balanceOf(seller)).toBe(sellerCash);

    await api(tokens.requester).post(`/wallets/${buyer}/cash`, { amount: (900_000n * UNIT).toString() });
    await worker.drain();
    const retried = await api(tokens.requester).post(`/trades/${created.body.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.settleAttempts).toBe(2);
    await worker.drain();

    expect((await trade(created.body.id)).status).toBe('SETTLED');
    expect(await security().balanceOf(buyer)).toBe(25n);
    expect(await cash().balanceOf(seller)).toBe(sellerCash + 900_000n * UNIT);
  });

  it('moves neither leg when the token rejects the delivery', async () => {
    const buyerCash = await cash().balanceOf(buyer);
    await operate('FREEZE_ADDRESS', { account: seller });
    const created = await report();
    await worker.drain();

    const failed = await trade(created.body.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.failure).toMatchObject({ step: 'settle', errorCode: 'AccountFrozen' });
    expect(await cash().balanceOf(buyer)).toBe(buyerCash);
    expect(await security().balanceOf(buyer)).toBe(25n);

    await operate('UNFREEZE_ADDRESS', { account: seller });
    await api(tokens.requester).post(`/trades/${created.body.id}/retry`);
    await worker.drain();
    expect((await trade(created.body.id)).status).toBe('SETTLED');
  });

  it('cancels a failed trade and refuses to retry or cancel it afterwards', async () => {
    await operate('FREEZE_ADDRESS', { account: seller });
    const created = await report();
    await worker.drain();
    expect((await trade(created.body.id)).status).toBe('FAILED');

    const cancelling = await api(tokens.requester).post(`/trades/${created.body.id}/cancel`, { reasonCode: 'COUNTERPARTY_REQUEST' });
    expect(cancelling.status).toBe(200);
    await worker.drain();
    expect((await trade(created.body.id)).status).toBe('CANCELLED');
    const onChain = await chain.contract('DvPSettlement').getTrade(created.body.tradeId);
    expect(onChain.status).toBe(3n);

    expect((await api(tokens.requester).post(`/trades/${created.body.id}/retry`)).status).toBe(409);
    expect((await api(tokens.requester).post(`/trades/${created.body.id}/cancel`, { reasonCode: 'AGAIN' })).status).toBe(409);
    await operate('UNFREEZE_ADDRESS', { account: seller });
  });

  it('refuses to retry or cancel a settled trade', async () => {
    const created = await report();
    await worker.drain();
    expect((await api(tokens.requester).post(`/trades/${created.body.id}/retry`)).status).toBe(409);
    expect((await api(tokens.requester).post(`/trades/${created.body.id}/cancel`, { reasonCode: 'TOO_LATE' })).status).toBe(409);
  });

  it('generates trade numbers through the mock venue', async () => {
    const first = await api(tokens.requester).post('/otc/trades', { seller, buyer, quantity: '1', price: UNIT.toString() });
    const second = await api(tokens.requester).post('/otc/trades', { seller, buyer, quantity: '1', price: UNIT.toString() });
    expect(first.status).toBe(201);
    expect(first.body.tradeNo).toMatch(/^OTC-\d{8}-\d{6}$/);
    expect(second.body.tradeNo).not.toBe(first.body.tradeNo);
    await worker.drain();
    expect((await trade(first.body.id)).status).toBe('SETTLED');
    expect((await trade(second.body.id)).status).toBe('SETTLED');
  });

  it('keeps the internal ledger in step with settlements', async () => {
    await indexer.syncToHead();
    const recon = await api(tokens.requester).post('/recon/run');
    expect(recon.body.mismatches).toEqual([]);
    const settledEvents = (await api(tokens.viewer).get('/events?name=TradeSettled')).body;
    expect(settledEvents.length).toBeGreaterThanOrEqual(5);
  });

  it('validates reports and enforces roles', async () => {
    expect((await report({ seller: buyer })).status).toBe(400);
    expect((await report({ quantity: '0' })).status).toBe(400);
    expect((await report({ price: '-1' })).status).toBe(400);
    expect((await report({ tradeNo: 'has spaces' })).status).toBe(400);
    expect((await report({ buyer: chain.keys.derive(180).address })).status).toBe(400);
    expect((await api(tokens.viewer).post('/trades', {})).status).toBe(403);
    expect((await api(tokens.viewer).get('/trades/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/trades')).status).toBe(401);
  });
});
