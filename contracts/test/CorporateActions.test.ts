import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { ISSUER_ROLE, REASON, deploySystem } from "./helpers/system.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const DAY = 24 * 60 * 60;

async function baseFixture() {
  const system = await deploySystem(connection);
  const { admin, alice, bob, carol, kyc, mint } = system;
  const usdc = await ethers.deployContract("USDC");
  await kyc(alice, "alice");
  await kyc(bob, "bob");
  await kyc(carol, "carol");
  await mint(alice, 300n);
  await mint(bob, 100n);
  return { ...system, usdc, treasury: admin };
}

describe("DividendDistributor", function () {
  const TOTAL = 4_000n;

  async function fixture() {
    const system = await baseFixture();
    const { admin, token, usdc, treasury } = system;
    const distributor = await ethers.deployContract("DividendDistributor", [admin.address]);
    await distributor.grantRole(ISSUER_ROLE, treasury.address);
    await usdc.mint(treasury.address, TOTAL * 10n);
    await usdc.connect(treasury).approve(await distributor.getAddress(), TOTAL * 10n);

    const recordBlock = await ethers.provider.getBlockNumber();
    await networkHelpers.mine();
    const now = BigInt(await networkHelpers.time.latest());
    const deadline = now + BigInt(30 * DAY);

    const tokenAddress = await token.getAddress();
    const usdcAddress = await usdc.getAddress();
    const create = (total = TOTAL, block = recordBlock, claimDeadline = deadline) =>
      distributor.connect(treasury).createDistribution(tokenAddress, usdcAddress, block, now, total, claimDeadline);

    return { ...system, distributor, recordBlock, now, deadline, create, tokenAddress, usdcAddress };
  }

  it("rejects a zero admin", async function () {
    const factory = await ethers.getContractFactory("DividendDistributor");
    await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  describe("creation", function () {
    it("pulls the cash and records the distribution", async function () {
      const { distributor, usdc, treasury, recordBlock, now, deadline, create, tokenAddress, usdcAddress } =
        await networkHelpers.loadFixture(fixture);
      await expect(create())
        .to.emit(distributor, "DistributionCreated")
        .withArgs(0n, tokenAddress, usdcAddress, recordBlock, now, TOTAL, deadline, treasury.address);
      expect(await usdc.balanceOf(await distributor.getAddress())).to.equal(TOTAL);
      expect(await distributor.distributionCount()).to.equal(1n);
      const stored = await distributor.getDistribution(0);
      expect(stored.totalAmount).to.equal(TOTAL);
      expect(stored.recordBlock).to.equal(BigInt(recordBlock));
      expect(stored.swept).to.equal(false);
    });

    it("rejects a record block that is not in the past", async function () {
      const { distributor, create } = await networkHelpers.loadFixture(fixture);
      const next = (await ethers.provider.getBlockNumber()) + 1;
      await expect(create(TOTAL, next)).to.be.revertedWithCustomError(distributor, "RecordBlockNotPast").withArgs(next);
    });

    it("rejects a record block at which nothing was issued", async function () {
      const { distributor, create } = await networkHelpers.loadFixture(fixture);
      await expect(create(TOTAL, 0)).to.be.revertedWithCustomError(distributor, "NoSupplyAtRecordBlock").withArgs(0);
    });

    it("rejects a zero amount, a past deadline and zero addresses", async function () {
      const { distributor, treasury, recordBlock, now, deadline, create, tokenAddress, usdcAddress } =
        await networkHelpers.loadFixture(fixture);
      await expect(create(0n)).to.be.revertedWithCustomError(distributor, "ZeroAmount");
      await expect(create(TOTAL, recordBlock, now)).to.be.revertedWithCustomError(distributor, "DeadlineNotInFuture");
      await expect(
        distributor.connect(treasury).createDistribution(ZeroAddress, usdcAddress, recordBlock, now, TOTAL, deadline),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
      await expect(
        distributor.connect(treasury).createDistribution(tokenAddress, ZeroAddress, recordBlock, now, TOTAL, deadline),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("rejects a caller without the issuer role", async function () {
      const { distributor, alice, recordBlock, now, deadline, tokenAddress, usdcAddress } =
        await networkHelpers.loadFixture(fixture);
      await expect(
        distributor.connect(alice).createDistribution(tokenAddress, usdcAddress, recordBlock, now, TOTAL, deadline),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  describe("claims", function () {
    it("pays each holder in proportion to the record-block balance", async function () {
      const { distributor, usdc, alice, bob, create } = await networkHelpers.loadFixture(fixture);
      await create();
      expect(await distributor.claimable(0, alice.address)).to.equal(3_000n);

      await expect(distributor.connect(alice).claim(0))
        .to.emit(distributor, "DividendClaimed")
        .withArgs(0n, alice.address, 3_000n);
      await distributor.connect(bob).claim(0);

      expect(await usdc.balanceOf(alice.address)).to.equal(3_000n);
      expect(await usdc.balanceOf(bob.address)).to.equal(1_000n);
      expect(await distributor.hasClaimed(0, alice.address)).to.equal(true);
      expect(await distributor.claimable(0, alice.address)).to.equal(0n);
    });

    it("ignores movements after the record block", async function () {
      const { distributor, token, usdc, alice, bob, carol, create } = await networkHelpers.loadFixture(fixture);
      await token.connect(alice).transfer(carol.address, 300n);
      await create();

      await distributor.connect(alice).claim(0);
      expect(await usdc.balanceOf(alice.address)).to.equal(3_000n);
      await expect(distributor.connect(carol).claim(0))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(0n, carol.address);
      await distributor.connect(bob).claim(0);
    });

    it("rejects a second claim", async function () {
      const { distributor, alice, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await distributor.connect(alice).claim(0);
      await expect(distributor.connect(alice).claim(0))
        .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
        .withArgs(0n, alice.address);
    });

    it("rejects a holder who is not verified or is frozen, until that is resolved", async function () {
      const { distributor, token, registry, registrar, enforcer, usdc, alice, bob, kyc, create } =
        await networkHelpers.loadFixture(fixture);
      await create();

      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await expect(distributor.connect(alice).claim(0))
        .to.be.revertedWithCustomError(distributor, "NotEligible")
        .withArgs(alice.address);
      await kyc(alice, "alice");
      await distributor.connect(alice).claim(0);
      expect(await usdc.balanceOf(alice.address)).to.equal(3_000n);

      await token.connect(enforcer).setAddressFrozen(bob.address, true, REASON);
      await expect(distributor.connect(bob).claim(0))
        .to.be.revertedWithCustomError(distributor, "NotEligible")
        .withArgs(bob.address);
      await token.connect(enforcer).setAddressFrozen(bob.address, false, REASON);
      await distributor.connect(bob).claim(0);
    });

    it("rejects claims after the deadline", async function () {
      const { distributor, alice, deadline, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(distributor.connect(alice).claim(0))
        .to.be.revertedWithCustomError(distributor, "ClaimWindowClosed")
        .withArgs(0n);
    });

    it("keeps distributions independent of each other", async function () {
      const { distributor, usdc, alice, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await create(800n);
      await distributor.connect(alice).claim(1);
      expect(await usdc.balanceOf(alice.address)).to.equal(600n);
      expect(await distributor.hasClaimed(0, alice.address)).to.equal(false);
      await distributor.connect(alice).claim(0);
      expect(await usdc.balanceOf(alice.address)).to.equal(3_600n);
    });
  });

  describe("sweep", function () {
    it("returns unclaimed cash and rounding remainders after the deadline", async function () {
      const { distributor, usdc, treasury, alice, carol, deadline, create } = await networkHelpers.loadFixture(fixture);
      // 4,001 over 400 units: alice 3,000, bob 1,000, 1 left over from rounding.
      await create(4_001n);
      await distributor.connect(alice).claim(0);

      await expect(distributor.connect(treasury).sweep(0, carol.address))
        .to.be.revertedWithCustomError(distributor, "ClaimWindowOpen")
        .withArgs(0n);

      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(distributor.connect(treasury).sweep(0, carol.address))
        .to.emit(distributor, "DistributionSwept")
        .withArgs(0n, carol.address, 1_001n, treasury.address);

      expect(await usdc.balanceOf(carol.address)).to.equal(1_001n);
      expect(await usdc.balanceOf(await distributor.getAddress())).to.equal(0n);
      const stored = await distributor.getDistribution(0);
      expect(stored.claimedAmount + 1_001n).to.equal(stored.totalAmount);
    });

    it("cannot sweep twice, to the zero address, or without the issuer role", async function () {
      const { distributor, treasury, alice, carol, deadline, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(distributor.connect(treasury).sweep(0, ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress",
      );
      await expect(distributor.connect(alice).sweep(0, alice.address)).to.be.revertedWithCustomError(
        distributor,
        "AccessControlUnauthorizedAccount",
      );
      await distributor.connect(treasury).sweep(0, carol.address);
      await expect(distributor.connect(treasury).sweep(0, carol.address))
        .to.be.revertedWithCustomError(distributor, "AlreadySwept")
        .withArgs(0n);
    });
  });
});

describe("RedemptionManager", function () {
  const PRICE = 1_000_000n; // 1 USDC per unit
  const SUPPLY = 400n;

  async function fixture() {
    const system = await baseFixture();
    const { admin, token, usdc, treasury } = system;
    const manager = await ethers.deployContract("RedemptionManager", [admin.address]);
    await manager.grantRole(ISSUER_ROLE, treasury.address);
    await token.grantRole(ISSUER_ROLE, await manager.getAddress());
    await usdc.mint(treasury.address, SUPPLY * PRICE * 10n);
    await usdc.connect(treasury).approve(await manager.getAddress(), SUPPLY * PRICE * 10n);

    const now = BigInt(await networkHelpers.time.latest());
    const deadline = now + BigInt(30 * DAY);
    const tokenAddress = await token.getAddress();
    const usdcAddress = await usdc.getAddress();
    const open = (price = PRICE, roundDeadline = deadline) =>
      manager.connect(treasury).openRedemption(tokenAddress, usdcAddress, price, roundDeadline);

    return { ...system, manager, deadline, now, open, tokenAddress, usdcAddress };
  }

  it("rejects a zero admin", async function () {
    const factory = await ethers.getContractFactory("RedemptionManager");
    await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  describe("opening", function () {
    it("pulls enough cash to redeem the whole supply", async function () {
      const { manager, usdc, treasury, deadline, open, tokenAddress, usdcAddress } =
        await networkHelpers.loadFixture(fixture);
      await expect(open())
        .to.emit(manager, "RedemptionOpened")
        .withArgs(0n, tokenAddress, usdcAddress, PRICE, SUPPLY * PRICE, deadline, treasury.address);
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(SUPPLY * PRICE);
      expect(await manager.roundCount()).to.equal(1n);
      expect((await manager.getRound(0)).deposited).to.equal(SUPPLY * PRICE);
    });

    it("rejects a zero price, a past deadline, zero addresses and an empty supply", async function () {
      const { manager, token, issuerOp, treasury, alice, bob, now, deadline, open, tokenAddress, usdcAddress } =
        await networkHelpers.loadFixture(fixture);
      await expect(open(0n)).to.be.revertedWithCustomError(manager, "ZeroAmount");
      await expect(open(PRICE, now)).to.be.revertedWithCustomError(manager, "DeadlineNotInFuture");
      await expect(
        manager.connect(treasury).openRedemption(ZeroAddress, usdcAddress, PRICE, deadline),
      ).to.be.revertedWithCustomError(manager, "ZeroAddress");
      await expect(
        manager.connect(treasury).openRedemption(tokenAddress, ZeroAddress, PRICE, deadline),
      ).to.be.revertedWithCustomError(manager, "ZeroAddress");

      await token.connect(issuerOp).burn(alice.address, 300n, REASON);
      await token.connect(issuerOp).burn(bob.address, 100n, REASON);
      await expect(open()).to.be.revertedWithCustomError(manager, "NothingToRedeem");
    });

    it("rejects a caller without the issuer role", async function () {
      const { manager, alice, deadline, tokenAddress, usdcAddress } = await networkHelpers.loadFixture(fixture);
      await expect(
        manager.connect(alice).openRedemption(tokenAddress, usdcAddress, PRICE, deadline),
      ).to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount");
    });
  });

  describe("redeeming", function () {
    it("burns the units and pays the holder in one transaction", async function () {
      const { manager, token, usdc, alice, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await expect(manager.connect(alice).redeem(0, 120n))
        .to.emit(manager, "Redeemed")
        .withArgs(0n, alice.address, 120n, 120n * PRICE)
        .and.to.emit(token, "Redeemed")
        .withArgs(alice.address, 120n, await manager.getAddress(), await manager.REDEMPTION_REASON());

      expect(await token.balanceOf(alice.address)).to.equal(180n);
      expect(await token.totalSupply()).to.equal(SUPPLY - 120n);
      expect(await usdc.balanceOf(alice.address)).to.equal(120n * PRICE);
      expect((await manager.getRound(0)).paid).to.equal(120n * PRICE);
    });

    it("cannot redeem frozen units", async function () {
      const { manager, token, enforcer, alice, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await token.connect(enforcer).freezePartialTokens(alice.address, 250n, REASON);
      await expect(manager.connect(alice).redeem(0, 51n))
        .to.be.revertedWithCustomError(token, "InsufficientFreeBalance")
        .withArgs(alice.address, 50n, 51n);
      await manager.connect(alice).redeem(0, 50n);
      expect(await token.getFrozenTokens(alice.address)).to.equal(250n);
    });

    it("cannot redeem from a frozen account", async function () {
      const { manager, token, usdc, enforcer, alice, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await expect(manager.connect(alice).redeem(0, 1n))
        .to.be.revertedWithCustomError(token, "AccountFrozen")
        .withArgs(alice.address);
      expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    });

    it("rejects a holder who is not verified", async function () {
      const { manager, registry, registrar, alice, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await expect(manager.connect(alice).redeem(0, 1n))
        .to.be.revertedWithCustomError(manager, "NotEligible")
        .withArgs(alice.address);
    });

    it("rejects more than the holder owns and a zero quantity", async function () {
      const { manager, token, bob, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await expect(manager.connect(bob).redeem(0, 101n)).to.be.revertedWithCustomError(token, "InsufficientFreeBalance");
      await expect(manager.connect(bob).redeem(0, 0n)).to.be.revertedWithCustomError(manager, "ZeroAmount");
    });

    it("rejects a payout the round's deposit cannot cover", async function () {
      const { manager, carol, mint, open } = await networkHelpers.loadFixture(fixture);
      await open();
      // Units issued after the round opened are not funded by its deposit.
      await mint(carol, 500n);
      await expect(manager.connect(carol).redeem(0, 401n))
        .to.be.revertedWithCustomError(manager, "InsufficientFunds")
        .withArgs(0n, SUPPLY * PRICE, 401n * PRICE);
    });

    it("rejects redemption after the deadline", async function () {
      const { manager, alice, deadline, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(manager.connect(alice).redeem(0, 1n))
        .to.be.revertedWithCustomError(manager, "RedemptionWindowClosed")
        .withArgs(0n);
    });

    it("fails without the token's issuer role and pays nothing", async function () {
      const { manager, token, usdc, admin, alice, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await token.connect(admin).revokeRole(ISSUER_ROLE, await manager.getAddress());
      await expect(manager.connect(alice).redeem(0, 1n)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("closing", function () {
    it("returns the unpaid deposit after the deadline", async function () {
      const { manager, usdc, treasury, alice, carol, deadline, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await manager.connect(alice).redeem(0, 300n);

      await expect(manager.connect(treasury).close(0, carol.address))
        .to.be.revertedWithCustomError(manager, "RedemptionWindowOpen")
        .withArgs(0n);

      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(manager.connect(treasury).close(0, carol.address))
        .to.emit(manager, "RedemptionClosed")
        .withArgs(0n, carol.address, 100n * PRICE, treasury.address);
      expect(await usdc.balanceOf(carol.address)).to.equal(100n * PRICE);
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(0n);
    });

    it("cannot close twice, to the zero address, or without the issuer role", async function () {
      const { manager, treasury, alice, carol, deadline, open } = await networkHelpers.loadFixture(fixture);
      await open();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(manager.connect(treasury).close(0, ZeroAddress)).to.be.revertedWithCustomError(
        manager,
        "ZeroAddress",
      );
      await expect(manager.connect(alice).close(0, alice.address)).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount",
      );
      await manager.connect(treasury).close(0, carol.address);
      await expect(manager.connect(treasury).close(0, carol.address))
        .to.be.revertedWithCustomError(manager, "AlreadyClosed")
        .withArgs(0n);
    });
  });
});
