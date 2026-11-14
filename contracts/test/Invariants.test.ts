import { expect } from "chai";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { network } from "hardhat";
import { InvestorType, investorId } from "./helpers/identity.js";
import { deploySystem, REASON } from "./helpers/system.js";

const connection = await network.create();
const { networkHelpers } = connection;

/** Deterministic PRNG (mulberry32) so a failing run can be replayed from its seed. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

const SEEDS = [1, 20270, 987654321];
const STEPS = 400;

describe("SecurityToken invariants", function () {
  async function fixture() {
    const system = await deploySystem(connection);
    const { alice, aliceSecond, bob, carol, dave, erin, kyc, maxBalance, maxHolders } = system;
    // Tight limits so that compliance rejections are part of the random walk.
    await maxBalance.setMaxBalance(InvestorType.Retail, 300n);
    await maxHolders.setMaxHolders(3n);

    const wallets: { signer: HardhatEthersSigner; label: string }[] = [
      { signer: alice, label: "alice" },
      { signer: aliceSecond, label: "alice" },
      { signer: bob, label: "bob" },
      { signer: carol, label: "carol" },
      { signer: dave, label: "dave" },
      { signer: erin, label: "dave" },
    ];
    for (const { signer, label } of wallets) await kyc(signer, label);
    return { ...system, wallets };
  }

  for (const seed of SEEDS) {
    it(`hold after ${STEPS} random operations (seed ${seed})`, async function () {
      const { token, registry, issuerOp, enforcer, pauser, registrar, outsider, wallets, kyc } =
        await networkHelpers.loadFixture(fixture);
      const random = prng(seed);
      const labels = [...new Set(wallets.map((w) => w.label))];
      let executed = 0;

      async function checkInvariants(step: number) {
        const at = `seed ${seed}, step ${step}`;
        const balances = new Map<string, bigint>();
        const perInvestor = new Map<string, bigint>(labels.map((label) => [label, 0n]));
        let sum = 0n;
        for (const { signer, label } of wallets) {
          const balance = await token.balanceOf(signer.address);
          balances.set(signer.address, balance);
          perInvestor.set(label, perInvestor.get(label)! + balance);
          sum += balance;
          expect(await token.getFrozenTokens(signer.address), `frozen <= balance, ${at}`).to.be.lte(balance);
          if (balance > 0n) {
            expect(await registry.investorOf(signer.address), `holder has an investor, ${at}`).to.equal(
              investorId(label),
            );
          }
        }
        expect(await token.balanceOf(outsider.address), `unregistered wallet holds nothing, ${at}`).to.equal(0n);

        const totalSupply = await token.totalSupply();
        expect(sum, `sum of balances == totalSupply, ${at}`).to.equal(totalSupply);
        expect(totalSupply, `totalSupply <= registeredSupply, ${at}`).to.be.lte(await token.registeredSupply());

        let holders = 0n;
        for (const label of labels) {
          const expected = perInvestor.get(label)!;
          expect(await token.investorBalanceOf(investorId(label)), `investor balance of ${label}, ${at}`).to.equal(
            expected,
          );
          if (expected > 0n) holders++;
        }
        expect(await token.holderCount(), `holder count, ${at}`).to.equal(holders);
      }

      for (let step = 0; step < STEPS; step++) {
        const a = random.pick(wallets);
        const b = random.pick(wallets);
        const amount = BigInt(random.int(80));
        const action = random.int(20);
        // A movement may only ever credit a wallet that is verified at that moment.
        const receiver = action <= 5 ? b : action <= 8 ? a : action === 12 || action === 13 ? b : undefined;
        const receiverVerified = receiver ? await registry.isVerified(receiver.signer.address) : true;
        const receiverBefore = receiver ? await token.balanceOf(receiver.signer.address) : 0n;

        try {
          if (action <= 5) {
            await token.connect(a.signer).transfer(b.signer.address, amount);
          } else if (action <= 8) {
            await token.connect(issuerOp).mint(a.signer.address, amount, REASON);
          } else if (action === 9) {
            await token.connect(issuerOp).burn(a.signer.address, amount, REASON);
          } else if (action === 10) {
            await token.connect(enforcer).freezePartialTokens(a.signer.address, amount, REASON);
          } else if (action === 11) {
            await token.connect(enforcer).unfreezePartialTokens(a.signer.address, amount, REASON);
          } else if (action === 12 || action === 13) {
            await token.connect(enforcer).forcedTransfer(a.signer.address, b.signer.address, amount, REASON);
          } else if (action === 14) {
            await token.connect(enforcer).setAddressFrozen(a.signer.address, random.int(2) === 0, REASON);
          } else if (action === 15) {
            await token.connect(enforcer).recoveryAddress(a.signer.address, b.signer.address, REASON);
          } else if (action === 16) {
            await registry.connect(registrar).revokeIdentity(a.signer.address, REASON);
          } else if (action === 17) {
            await kyc(a.signer, a.label);
          } else if (action === 18 && random.int(4) === 0) {
            // Pausing is rare and short-lived so the walk keeps exercising ordinary movements.
            await token.connect(pauser).pause(REASON);
          } else if (await token.paused()) {
            await token.connect(pauser).unpause(REASON);
          } else {
            await kyc(b.signer, b.label);
          }
          executed++;
          if (receiver && !receiverVerified) {
            expect(
              await token.balanceOf(receiver.signer.address),
              `unverified wallet was credited, seed ${seed}, step ${step}`,
            ).to.be.lte(receiverBefore);
          }
        } catch (error) {
          // Rejections are expected; assertion failures are not.
          if (error instanceof Error && error.name === "AssertionError") throw error;
        }

        if (step % 20 === 19) await checkInvariants(step);
      }

      await checkInvariants(STEPS);
      // Guards against a walk in which nearly everything reverted and nothing was exercised.
      expect(executed, "operations that succeeded").to.be.greaterThan(STEPS / 4);
    });
  }
});
