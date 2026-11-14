import type { INestApplication } from '@nestjs/common';
import { id as keccakId } from 'ethers';
import request from 'supertest';
import { ChainService } from '../src/chain/chain.service.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { createApp } from './setup/app.js';
import { operatorTokens } from './setup/operators.js';

const EVIDENCE = keccakId('evidence.pdf');

describe('corporate actions', () => {
  let app: INestApplication;
  let worker: OutboxWorker;
  let chain: ChainService;
  let tokens: Awaited<ReturnType<typeof operatorTokens>>;
  let alice: string;
  let bob: string;
  let supplyBefore: bigint;

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
  const advanceTime = async (seconds: number) => {
    await chain.provider.send('evm_increaseTime', [seconds]);
    await chain.provider.send('evm_mine', []);
  };

  async function operate(type: string, params: object): Promise<void> {
    const created = await api(tokens.requester).post('/operations', { type, params, reasonCode: 'TEST', evidenceHash: EVIDENCE });
    if (created.body.needsApproval) await api(tokens.approver).post(`/operations/${created.body.id}/approve`);
    await worker.drain();
  }

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(OutboxWorker);
    chain = app.get(ChainService);
    tokens = await operatorTokens(app);
    const a = await api(tokens.requester).post('/investors', { name: 'Dividend Alice', country: 410, investorType: 0 });
    const b = await api(tokens.requester).post('/investors', { name: 'Dividend Bob', country: 410, investorType: 0 });
    alice = a.body.wallets[0].address;
    bob = b.body.wallets[0].address;
    await worker.drain();
    await operate('SET_REGISTERED_SUPPLY', { amount: '9000000' });
    supplyBefore = await security().totalSupply();
    await operate('MINT', { to: alice, amount: '300' });
    await operate('MINT', { to: bob, amount: '100' });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('dividends', () => {
    it('opens a dividend, pays claims pro rata to the record block, and reports the amounts', async () => {
      const supply: bigint = await security().totalSupply();
      const total = supply * 10n; // 10 units of cash per security unit
      const opened = await api(tokens.requester).post('/dividends', { totalAmount: total.toString(), claimDays: 30 });
      expect(opened.status).toBe(201);
      expect(opened.body.status).toBe('OPENING');
      await worker.drain();

      const open = await api(tokens.viewer).get(`/dividends/${opened.body.id}`);
      expect(open.body.status).toBe('OPEN');
      expect(open.body.onChainId).toMatch(/^\d+$/);
      expect(open.body.recordBlock).toBeGreaterThan(0);

      // A transfer after the record block does not change anyone's share.
      await operate('FORCED_TRANSFER', { from: alice, to: bob, amount: '300' });

      const aliceBefore: bigint = await cash().balanceOf(alice);
      await api(tokens.requester).post(`/dividends/${opened.body.id}/claims`, { wallet: alice });
      await api(tokens.requester).post(`/dividends/${opened.body.id}/claims`, { wallet: bob });
      await worker.drain();

      expect((await cash().balanceOf(alice)) - aliceBefore).toBe(3_000n);
      const done = await api(tokens.viewer).get(`/dividends/${opened.body.id}`);
      const byWallet = Object.fromEntries(done.body.claims.map((claim: { wallet: string }) => [claim.wallet, claim]));
      expect(byWallet[alice]).toMatchObject({ status: 'CONFIRMED', paid: '3000' });
      expect(byWallet[bob]).toMatchObject({ status: 'CONFIRMED', paid: '1000' });
    });

    it('rejects a second claim and a claim from a frozen account on chain', async () => {
      const [dividend] = (await api(tokens.viewer).get('/dividends')).body;
      await api(tokens.requester).post(`/dividends/${dividend.id}/claims`, { wallet: alice });
      await worker.drain();
      const again = (await api(tokens.viewer).get(`/dividends/${dividend.id}`)).body.claims.at(-1);
      expect(again).toMatchObject({ wallet: alice, status: 'FAILED', errorCode: 'AlreadyClaimed', paid: null });

      const supply: bigint = await security().totalSupply();
      const second = await api(tokens.requester).post('/dividends', { totalAmount: (supply * 2n).toString(), claimDays: 30 });
      await worker.drain();
      await operate('FREEZE_ADDRESS', { account: bob });
      await api(tokens.requester).post(`/dividends/${second.body.id}/claims`, { wallet: bob });
      await worker.drain();
      const frozenClaim = (await api(tokens.viewer).get(`/dividends/${second.body.id}`)).body.claims[0];
      expect(frozenClaim).toMatchObject({ status: 'FAILED', errorCode: 'NotEligible' });
      await operate('UNFREEZE_ADDRESS', { account: bob });
    });

    it('sweeps unclaimed cash back to the treasury only after the deadline', async () => {
      const dividends = (await api(tokens.viewer).get('/dividends')).body;
      const unclaimed = dividends[0];
      const treasury = chain.deployment.roles.treasury;

      const early = await api(tokens.requester).post(`/dividends/${unclaimed.id}/sweep`);
      expect(early.status).toBe(200);
      await worker.drain();
      // The contract refuses before the deadline, so the dividend stays open.
      expect((await api(tokens.viewer).get(`/dividends/${unclaimed.id}`)).body.status).toBe('OPEN');

      await advanceTime(31 * 24 * 60 * 60);
      const before: bigint = await cash().balanceOf(treasury);
      await api(tokens.requester).post(`/dividends/${unclaimed.id}/sweep`);
      await worker.drain();
      expect((await api(tokens.viewer).get(`/dividends/${unclaimed.id}`)).body.status).toBe('CLOSED');
      expect((await cash().balanceOf(treasury)) - before).toBe(BigInt(unclaimed.amount));

      expect((await api(tokens.requester).post(`/dividends/${unclaimed.id}/claims`, { wallet: alice })).status).toBe(409);
      expect((await api(tokens.requester).post(`/dividends/${unclaimed.id}/sweep`)).status).toBe(409);
    });

    it('validates input and enforces roles', async () => {
      expect((await api(tokens.requester).post('/dividends', { totalAmount: '0', claimDays: 30 })).status).toBe(400);
      expect((await api(tokens.requester).post('/dividends', { totalAmount: '10', claimDays: 0 })).status).toBe(400);
      expect((await api(tokens.viewer).post('/dividends', { totalAmount: '10', claimDays: 1 })).status).toBe(403);
      expect((await api(tokens.viewer).get('/dividends/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      const [dividend] = (await api(tokens.viewer).get('/dividends')).body;
      expect((await api(tokens.viewer).get(`/redemptions/${dividend.id}`)).status).toBe(404);
    });
  });

  describe('redemptions', () => {
    // KYC claims issued in the setup expired when time was advanced past the dividend deadline.
    beforeAll(async () => {
      await api(tokens.requester).post(`/wallets/${alice}/renew`);
      await api(tokens.requester).post(`/wallets/${bob}/renew`);
      await worker.drain();
    });

    it('redeems units for cash at the round price and cancels the units', async () => {
      const opened = await api(tokens.requester).post('/redemptions', { pricePerUnit: '1000000', claimDays: 30 });
      expect(opened.status).toBe(201);
      await worker.drain();
      const open = await api(tokens.viewer).get(`/redemptions/${opened.body.id}`);
      expect(open.body.status).toBe('OPEN');

      const supply: bigint = await security().totalSupply();
      const bobUnits: bigint = await security().balanceOf(bob);
      const bobCash: bigint = await cash().balanceOf(bob);
      expect(bobUnits).toBe(400n);

      await api(tokens.requester).post(`/redemptions/${opened.body.id}/redeem`, { wallet: bob, quantity: '150' });
      await worker.drain();

      expect(await security().balanceOf(bob)).toBe(250n);
      expect(await security().totalSupply()).toBe(supply - 150n);
      expect((await cash().balanceOf(bob)) - bobCash).toBe(150_000_000n);
      const done = await api(tokens.viewer).get(`/redemptions/${opened.body.id}`);
      expect(done.body.claims[0]).toMatchObject({ wallet: bob, quantity: '150', status: 'CONFIRMED', paid: '150000000' });
    });

    it('does not let frozen units be redeemed', async () => {
      const [round] = (await api(tokens.viewer).get('/redemptions')).body;
      await operate('FREEZE_PARTIAL', { account: bob, amount: '200' });
      await api(tokens.requester).post(`/redemptions/${round.id}/redeem`, { wallet: bob, quantity: '51' });
      await worker.drain();
      const refused = (await api(tokens.viewer).get(`/redemptions/${round.id}`)).body.claims.at(-1);
      expect(refused).toMatchObject({ status: 'FAILED', errorCode: 'InsufficientFreeBalance', paid: null });
      expect(await security().balanceOf(bob)).toBe(250n);
      await operate('UNFREEZE_PARTIAL', { account: bob, amount: '200' });
    });

    it('returns the unpaid deposit to the treasury after the deadline', async () => {
      const [round] = (await api(tokens.viewer).get('/redemptions')).body;
      const treasury = chain.deployment.roles.treasury;
      await advanceTime(31 * 24 * 60 * 60);
      const before: bigint = await cash().balanceOf(treasury);
      await api(tokens.requester).post(`/redemptions/${round.id}/close`);
      await worker.drain();
      expect((await api(tokens.viewer).get(`/redemptions/${round.id}`)).body.status).toBe('CLOSED');
      expect(await cash().balanceOf(treasury)).toBeGreaterThan(before);
      expect(await cash().balanceOf(chain.addressOf('RedemptionManager'))).toBe(0n);
    });

    it('validates input and enforces roles', async () => {
      expect((await api(tokens.requester).post('/redemptions', { pricePerUnit: '0', claimDays: 30 })).status).toBe(400);
      expect((await api(tokens.viewer).post('/redemptions', { pricePerUnit: '1', claimDays: 30 })).status).toBe(403);
      const [round] = (await api(tokens.viewer).get('/redemptions')).body;
      expect((await api(tokens.requester).post(`/redemptions/${round.id}/redeem`, { wallet: bob, quantity: '0' })).status).toBe(400);
      expect((await api(tokens.requester).post(`/redemptions/${round.id}/redeem`, { wallet: bob, quantity: '1' })).status).toBe(409);
    });
  });

  it('leaves the ledger consistent with the chain', async () => {
    const recon = await api(tokens.requester).post('/recon/run');
    expect(recon.body.mismatches).toEqual([]);
    expect(await security().totalSupply()).toBe(supplyBefore + 400n - 150n);
  });
});
