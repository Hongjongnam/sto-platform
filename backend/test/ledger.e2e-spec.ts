import type { INestApplication } from '@nestjs/common';
import { id as keccakId } from 'ethers';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ChainService } from '../src/chain/chain.service.js';
import { IndexerService } from '../src/ledger/indexer.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';
import { operatorTokens } from './setup/operators.js';

const EVIDENCE = keccakId('evidence.pdf');

describe('ledger', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let indexer: IndexerService;
  let chain: ChainService;
  let dataSource: DataSource;
  let tokens: Awaited<ReturnType<typeof operatorTokens>>;
  let alice: string;
  let aliceSecond: string;
  let bob: string;
  let aliceInvestor: string;

  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => http.get(path).set(auth),
      post: (path: string, body?: object) => http.post(path).set(auth).send(body ?? {}),
    };
  };

  /** Files an operation, approves it if needed, and waits for the chain and the ledger. */
  async function operate(type: string, params: object, reasonCode = 'TEST'): Promise<void> {
    const created = await api(tokens.requester).post('/operations', { type, params, reasonCode, evidenceHash: EVIDENCE });
    expect(created.status).toBe(201);
    if (created.body.needsApproval) await api(tokens.approver).post(`/operations/${created.body.id}/approve`);
    await worker.drain();
    await indexer.syncToHead();
    const done = await api(tokens.viewer).get(`/operations/${created.body.id}`);
    expect(done.body.execution.status, JSON.stringify(done.body.execution)).toBe('CONFIRMED');
  }

  const holding = async (wallet: string) =>
    (await api(tokens.viewer).get('/ledger/holdings')).body.find((row: { wallet: string }) => row.wallet === wallet);
  const reconcile = async () => (await api(tokens.requester).post('/recon/run')).body;

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    indexer = app.get(IndexerService);
    chain = app.get(ChainService);
    dataSource = app.get(DataSource);
    tokens = await operatorTokens(app);

    const a = await api(tokens.requester).post('/investors', { name: 'Ledger Alice', country: 410, investorType: 0 });
    const withSecond = await api(tokens.requester).post(`/investors/${a.body.id}/wallets`);
    const b = await api(tokens.requester).post('/investors', { name: 'Ledger Bob', country: 410, investorType: 0 });
    aliceInvestor = a.body.id;
    [alice, aliceSecond] = withSecond.body.wallets.map((wallet: { address: string }) => wallet.address);
    bob = b.body.wallets[0].address;
    await worker.drain();
    await operate('SET_REGISTERED_SUPPLY', { amount: '5000000' }, 'REGISTRATION');
  });

  afterAll(async () => {
    await app.close();
  });

  it('mirrors issuance and transfers in the internal ledger', async () => {
    const before = (await api(tokens.viewer).get('/ledger/state')).body;
    await operate('MINT', { to: alice, amount: '400' });
    await operate('MINT', { to: bob, amount: '100' });
    await operate('FORCED_TRANSFER', { from: alice, to: bob, amount: '50' }, 'COURT_ORDER');

    expect(await holding(alice)).toMatchObject({ balance: '350', frozen: '0', investorName: 'Ledger Alice' });
    expect(await holding(bob)).toMatchObject({ balance: '150' });
    const state = (await api(tokens.viewer).get('/ledger/state')).body;
    expect(BigInt(state.totalSupply) - BigInt(before.totalSupply)).toBe(500n);
    expect(state.registeredSupply).toBe('5000000');
    expect(state.indexedBlock).toBe(state.chainBlock);
  });

  it('mirrors freezes, including the tokens a forced transfer releases', async () => {
    await operate('FREEZE_PARTIAL', { account: alice, amount: '300' }, 'COURT_ORDER');
    expect(await holding(alice)).toMatchObject({ balance: '350', frozen: '300' });

    // 50 free + 100 released from the frozen amount.
    await operate('FORCED_TRANSFER', { from: alice, to: bob, amount: '150' }, 'COURT_ORDER');
    expect(await holding(alice)).toMatchObject({ balance: '200', frozen: '200' });

    await operate('FREEZE_ADDRESS', { account: alice }, 'COURT_ORDER');
    expect((await holding(alice)).addressFrozen).toBe(true);
  });

  it('mirrors wallet recovery, which moves frozen state without its own events', async () => {
    await operate('RECOVERY', { lostWallet: alice, newWallet: aliceSecond }, 'LOST_KEY');
    expect(await holding(alice)).toMatchObject({ balance: '0', frozen: '0', addressFrozen: false });
    expect(await holding(aliceSecond)).toMatchObject({ balance: '200', frozen: '200', addressFrozen: true });
  });

  it('mirrors pause and unpause', async () => {
    await operate('PAUSE', {}, 'MAINTENANCE');
    expect((await api(tokens.viewer).get('/ledger/state')).body.paused).toBe(true);
    await operate('UNPAUSE', {}, 'MAINTENANCE');
    expect((await api(tokens.viewer).get('/ledger/state')).body.paused).toBe(false);
  });

  it('reconciles cleanly against the chain', async () => {
    const report = await reconcile();
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.walletsChecked).toBeGreaterThanOrEqual(3);
    expect(report.blockNumber).toBe(await chain.provider.getBlockNumber());
  });

  it('is idempotent: reading the same blocks again changes nothing', async () => {
    const before = await dataSource.query('SELECT COUNT(*)::int AS events FROM chain_events');
    const holdingsBefore = (await api(tokens.viewer).get('/ledger/holdings')).body;

    // Rewind the cursor so every block is read a second time.
    await dataSource.query('UPDATE indexer_cursor SET last_block = $1 WHERE id = 1', [chain.deployment.startBlock - 1]);
    await indexer.syncToHead();

    expect(await dataSource.query('SELECT COUNT(*)::int AS events FROM chain_events')).toEqual(before);
    expect((await api(tokens.viewer).get('/ledger/holdings')).body).toEqual(holdingsBefore);
    expect((await reconcile()).ok).toBe(true);
  });

  it('detects a corrupted ledger and repairs it by replaying events', async () => {
    await dataSource.query('UPDATE holdings SET balance = balance + 7 WHERE wallet = $1', [bob]);
    await dataSource.query('UPDATE holdings SET frozen = 0 WHERE wallet = $1', [aliceSecond]);
    await dataSource.query('UPDATE token_state SET registered_supply = 1 WHERE id = 1');

    const broken = await reconcile();
    expect(broken.ok).toBe(false);
    const fields = broken.mismatches.map((mismatch: { field: string; subject?: string }) => `${mismatch.field}:${mismatch.subject ?? ''}`);
    expect(fields).toContain(`balance:${bob}`);
    expect(fields).toContain(`frozen:${aliceSecond}`);
    expect(fields).toContain('registeredSupply:');
    expect(fields).toContain('sumOfBalances:');
    expect(fields.some((field: string) => field.startsWith('investorBalance:'))).toBe(true);
    const bobMismatch = broken.mismatches.find((mismatch: { field: string; subject?: string }) => mismatch.field === 'balance' && mismatch.subject === bob);
    expect(BigInt(bobMismatch.ledger) - BigInt(bobMismatch.chain)).toBe(7n);

    const rebuilt = await api(tokens.approver).post('/recon/rebuild');
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.events).toBeGreaterThan(0);

    const repaired = await reconcile();
    expect(repaired.mismatches).toEqual([]);
    expect(repaired.ok).toBe(true);

    const reports = (await api(tokens.viewer).get('/recon/reports')).body;
    expect(reports[0].ok).toBe(true);
    expect(reports.some((report: { ok: boolean }) => !report.ok)).toBe(true);
  });

  it('exposes the event stream as an audit trail', async () => {
    const forced = (await api(tokens.viewer).get('/events?name=ForcedTransfer')).body;
    expect(forced.length).toBeGreaterThanOrEqual(2);
    expect(forced[0]).toMatchObject({ contract: 'SecurityToken', name: 'ForcedTransfer' });
    expect(forced[0].args.operator).toBe(chain.deployment.roles.enforcer);
    expect(forced[0].args.reason).toMatch(/^0x[0-9a-f]{64}$/);

    const aboutAlice = (await api(tokens.viewer).get(`/events?address=${alice}&limit=500`)).body;
    expect(aboutAlice.length).toBeGreaterThan(3);
    expect(aboutAlice.every((event: { args: object }) => JSON.stringify(event.args).includes(alice))).toBe(true);

    const registered = (await api(tokens.viewer).get('/events?contract=IdentityRegistry&name=IdentityRegistered')).body;
    expect(registered.length).toBeGreaterThanOrEqual(3);

    const page = (await api(tokens.viewer).get('/events?limit=2')).body;
    expect(page).toHaveLength(2);
    const next = (await api(tokens.viewer).get(`/events?limit=2&beforeId=${page[1].id}`)).body;
    expect(next[0].id).toBeLessThan(page[1].id);
    expect((await api(tokens.viewer).get('/events?limit=0')).status).toBe(400);
  });

  it('restricts reconciliation and rebuild by role', async () => {
    expect((await api(tokens.viewer).post('/recon/run')).status).toBe(403);
    expect((await api(tokens.requester).post('/recon/rebuild')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/ledger/holdings')).status).toBe(401);
    // The investor used above is still resolvable.
    expect((await api(tokens.viewer).get(`/investors/${aliceInvestor}`)).status).toBe(200);
  });
});
