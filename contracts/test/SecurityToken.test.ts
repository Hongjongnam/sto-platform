import { expect } from "chai";
import { encodeBytes32String, ZeroAddress } from "ethers";
import { network } from "hardhat";
import { InvestorType, investorId, ONE_YEAR } from "./helpers/identity.js";
import {
  deploySystem,
  ENFORCER_ROLE,
  ISSUER_ROLE,
  REASON,
  REGISTERED_SUPPLY,
  RETAIL_LIMIT,
  UPGRADER_ROLE,
} from "./helpers/system.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const COURT_ORDER = encodeBytes32String("COURT_ORDER");

describe("SecurityToken", function () {
  async function fixture() {
    return deploySystem(connection);
  }

  /** alice and bob verified, alice holding 500. */
  async function fundedFixture() {
    const system = await deploySystem(connection);
    await system.kyc(system.alice, "alice");
    await system.kyc(system.bob, "bob");
    await system.mint(system.alice, 500n);
    return system;
  }

  describe("initialization", function () {
    it("sets metadata, references and the admin", async function () {
      const { token, registry, compliance, admin } = await networkHelpers.loadFixture(fixture);
      expect(await token.name()).to.equal("Example Fund Unit");
      expect(await token.symbol()).to.equal("EFU");
      expect(await token.decimals()).to.equal(0n);
      expect(await token.identityRegistry()).to.equal(await registry.getAddress());
      expect(await token.compliance()).to.equal(await compliance.getAddress());
      expect(await token.defaultAdmin()).to.equal(admin.address);
      expect(await token.registeredSupply()).to.equal(REGISTERED_SUPPLY);
    });

    it("cannot be initialized twice", async function () {
      const { token, registry, compliance, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(
        token.initialize("x", "x", outsider.address, 0, await registry.getAddress(), await compliance.getAddress()),
      ).to.be.revertedWithCustomError(token, "InvalidInitialization");
    });

    it("locks the implementation contract", async function () {
      const { registry, compliance, outsider } = await networkHelpers.loadFixture(fixture);
      const implementation = await ethers.deployContract("SecurityToken");
      await expect(
        implementation.initialize(
          "x",
          "x",
          outsider.address,
          0,
          await registry.getAddress(),
          await compliance.getAddress(),
        ),
      ).to.be.revertedWithCustomError(implementation, "InvalidInitialization");
    });

    it("rejects a zero registry or compliance", async function () {
      const { upgradesApi, registry, compliance, admin } = await networkHelpers.loadFixture(fixture);
      const factory = await ethers.getContractFactory("SecurityToken");
      await expect(
        upgradesApi.deployProxy(factory, ["x", "x", admin.address, 0, ZeroAddress, await compliance.getAddress()], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(
        upgradesApi.deployProxy(factory, ["x", "x", admin.address, 0, await registry.getAddress(), ZeroAddress], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("issuance", function () {
    it("mints to a verified investor and records who and why", async function () {
      const { token, issuerOp, alice, kyc } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await expect(token.connect(issuerOp).mint(alice.address, 100n, REASON))
        .to.emit(token, "Issued")
        .withArgs(alice.address, 100n, issuerOp.address, REASON);
      expect(await token.balanceOf(alice.address)).to.equal(100n);
      expect(await token.totalSupply()).to.equal(100n);
    });

    it("rejects minting to an unverified wallet", async function () {
      const { token, outsider, mint } = await networkHelpers.loadFixture(fixture);
      await expect(mint(outsider, 1n)).to.be.revertedWithCustomError(token, "NotVerified").withArgs(outsider.address);
    });

    it("rejects minting to a frozen account", async function () {
      const { token, enforcer, alice, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await expect(mint(alice, 1n)).to.be.revertedWithCustomError(token, "AccountFrozen").withArgs(alice.address);
    });

    it("rejects minting beyond the registered supply", async function () {
      const { token, registrar, alice, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await mint(alice, 100n);
      await token.connect(registrar).setRegisteredSupply(150n, REASON);
      await expect(mint(alice, 51n))
        .to.be.revertedWithCustomError(token, "RegisteredSupplyExceeded")
        .withArgs(151n, 150n);
      await mint(alice, 50n);
    });

    it("rejects minting from an account without the issuer role", async function () {
      const { token, alice, kyc } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await expect(token.connect(alice).mint(alice.address, 1n, REASON))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, ISSUER_ROLE);
    });

    it("burns free balance and records who and why", async function () {
      const { token, issuerOp, alice } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(issuerOp).burn(alice.address, 200n, REASON))
        .to.emit(token, "Redeemed")
        .withArgs(alice.address, 200n, issuerOp.address, REASON);
      expect(await token.balanceOf(alice.address)).to.equal(300n);
      expect(await token.totalSupply()).to.equal(300n);
    });

    it("does not burn frozen tokens", async function () {
      const { token, issuerOp, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).freezePartialTokens(alice.address, 400n, REASON);
      await expect(token.connect(issuerOp).burn(alice.address, 101n, REASON))
        .to.be.revertedWithCustomError(token, "InsufficientFreeBalance")
        .withArgs(alice.address, 100n, 101n);
      await token.connect(issuerOp).burn(alice.address, 100n, REASON);
      expect(await token.getFrozenTokens(alice.address)).to.equal(400n);
    });

    it("does not burn from a frozen account", async function () {
      const { token, issuerOp, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await expect(token.connect(issuerOp).burn(alice.address, 1n, REASON))
        .to.be.revertedWithCustomError(token, "AccountFrozen")
        .withArgs(alice.address);
    });

    it("burns from a holder whose identity was revoked", async function () {
      const { token, registry, registrar, issuerOp, alice } = await networkHelpers.loadFixture(fundedFixture);
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await token.connect(issuerOp).burn(alice.address, 500n, REASON);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it("rejects burning from an account without the issuer role", async function () {
      const { token, alice } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(alice).burn(alice.address, 1n, REASON)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("registered supply", function () {
    it("is set by the registrar with an event", async function () {
      const { token, registrar } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(registrar).setRegisteredSupply(2_000n, REASON))
        .to.emit(token, "RegisteredSupplySet")
        .withArgs(REGISTERED_SUPPLY, 2_000n, registrar.address, REASON);
      expect(await token.registeredSupply()).to.equal(2_000n);
    });

    it("cannot be set below the total supply", async function () {
      const { token, registrar } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(registrar).setRegisteredSupply(499n, REASON))
        .to.be.revertedWithCustomError(token, "RegisteredSupplyBelowTotalSupply")
        .withArgs(499n, 500n);
      await token.connect(registrar).setRegisteredSupply(500n, REASON);
    });

    it("rejects a caller without the registrar role", async function () {
      const { token, admin } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(admin).setRegisteredSupply(1n, REASON)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("transfers", function () {
    it("moves tokens between verified investors", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(alice).transfer(bob.address, 120n))
        .to.emit(token, "Transfer")
        .withArgs(alice.address, bob.address, 120n);
      expect(await token.balanceOf(alice.address)).to.equal(380n);
      expect(await token.balanceOf(bob.address)).to.equal(120n);
    });

    it("rejects a transfer to an unverified wallet", async function () {
      const { token, alice, outsider } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(alice).transfer(outsider.address, 1n))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(outsider.address);
    });

    it("rejects a transfer from a holder whose identity was revoked", async function () {
      const { token, registry, registrar, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(500n);
    });

    it("rejects a transfer from a holder whose identity has expired", async function () {
      const { token, alice, bob, kyc } = await networkHelpers.loadFixture(fundedFixture);
      await networkHelpers.time.increase(ONE_YEAR + 1);
      await kyc(bob, "bob");
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(alice.address);
    });

    it("rejects transfers to and from a frozen account", async function () {
      const { token, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).setAddressFrozen(bob.address, true, REASON);
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "AccountFrozen")
        .withArgs(bob.address);
      await token.connect(enforcer).setAddressFrozen(bob.address, false, REASON);
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "AccountFrozen")
        .withArgs(alice.address);
    });

    it("only lets the free balance move when part of it is frozen", async function () {
      const { token, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).freezePartialTokens(alice.address, 300n, REASON);
      expect(await token.freeBalanceOf(alice.address)).to.equal(200n);
      await expect(token.connect(alice).transfer(bob.address, 201n))
        .to.be.revertedWithCustomError(token, "InsufficientFreeBalance")
        .withArgs(alice.address, 200n, 201n);
      await token.connect(alice).transfer(bob.address, 200n);
      expect(await token.balanceOf(alice.address)).to.equal(300n);
    });

    it("applies the same checks to transferFrom", async function () {
      const { token, alice, bob, carol, outsider, kyc } = await networkHelpers.loadFixture(fundedFixture);
      await kyc(carol, "carol");
      await token.connect(alice).approve(carol.address, 100n);
      await expect(
        token.connect(carol).transferFrom(alice.address, outsider.address, 10n),
      ).to.be.revertedWithCustomError(token, "NotVerified");
      await token.connect(carol).transferFrom(alice.address, bob.address, 10n);
      expect(await token.balanceOf(bob.address)).to.equal(10n);
      expect(await token.allowance(alice.address, carol.address)).to.equal(90n);
    });

    it("rejects a transfer that breaks a compliance rule", async function () {
      const { token, alice, bob, carol, kyc, mint } = await networkHelpers.loadFixture(fundedFixture);
      await kyc(carol, "carol");
      await mint(carol, RETAIL_LIMIT);
      await token.connect(alice).transfer(bob.address, 500n);
      await expect(token.connect(carol).transfer(bob.address, 501n))
        .to.be.revertedWithCustomError(token, "ComplianceRejected")
        .withArgs(carol.address, bob.address, 501n);
    });
  });

  describe("freezing", function () {
    it("freezes and unfreezes an account with events", async function () {
      const { token, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).setAddressFrozen(alice.address, true, COURT_ORDER))
        .to.emit(token, "AddressFrozen")
        .withArgs(alice.address, true, enforcer.address, COURT_ORDER);
      expect(await token.isFrozen(alice.address)).to.equal(true);
      await token.connect(enforcer).setAddressFrozen(alice.address, false, COURT_ORDER);
      expect(await token.isFrozen(alice.address)).to.equal(false);
    });

    it("freezes and releases part of a balance with events", async function () {
      const { token, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).freezePartialTokens(alice.address, 300n, COURT_ORDER))
        .to.emit(token, "TokensFrozen")
        .withArgs(alice.address, 300n, enforcer.address, COURT_ORDER);
      await expect(token.connect(enforcer).unfreezePartialTokens(alice.address, 100n, COURT_ORDER))
        .to.emit(token, "TokensUnfrozen")
        .withArgs(alice.address, 100n, enforcer.address, COURT_ORDER);
      expect(await token.getFrozenTokens(alice.address)).to.equal(200n);
    });

    it("cannot freeze more than the free balance or release more than is frozen", async function () {
      const { token, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).freezePartialTokens(alice.address, 300n, REASON);
      await expect(token.connect(enforcer).freezePartialTokens(alice.address, 201n, REASON))
        .to.be.revertedWithCustomError(token, "InsufficientFreeBalance")
        .withArgs(alice.address, 200n, 201n);
      await expect(token.connect(enforcer).unfreezePartialTokens(alice.address, 301n, REASON))
        .to.be.revertedWithCustomError(token, "InsufficientFrozenBalance")
        .withArgs(alice.address, 300n, 301n);
    });

    it("rejects callers without the enforcer role", async function () {
      const { token, issuerOp, alice } = await networkHelpers.loadFixture(fundedFixture);
      const unauthorized = token.connect(issuerOp);
      for (const call of [
        unauthorized.setAddressFrozen(alice.address, true, REASON),
        unauthorized.freezePartialTokens(alice.address, 1n, REASON),
        unauthorized.unfreezePartialTokens(alice.address, 1n, REASON),
      ]) {
        await expect(call)
          .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
          .withArgs(issuerOp.address, ENFORCER_ROLE);
      }
    });
  });

  describe("forced transfer", function () {
    it("moves tokens regardless of freezes, pause and compliance", async function () {
      const { token, enforcer, pauser, maxBalance, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await token.connect(enforcer).setAddressFrozen(bob.address, true, REASON);
      await token.connect(pauser).pause(REASON);
      await maxBalance.setMaxBalance(InvestorType.Retail, 0);

      await expect(token.connect(enforcer).forcedTransfer(alice.address, bob.address, 500n, COURT_ORDER))
        .to.emit(token, "ForcedTransfer")
        .withArgs(alice.address, bob.address, 500n, enforcer.address, COURT_ORDER);
      expect(await token.balanceOf(bob.address)).to.equal(500n);
    });

    it("requires a verified receiver", async function () {
      const { token, enforcer, alice, outsider } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).forcedTransfer(alice.address, outsider.address, 1n, COURT_ORDER))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(outsider.address);
    });

    it("moves tokens out of a wallet whose identity was revoked", async function () {
      const { token, registry, registrar, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await token.connect(enforcer).forcedTransfer(alice.address, bob.address, 500n, COURT_ORDER);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.holderCount()).to.equal(1n);
    });

    it("releases frozen tokens only as far as needed", async function () {
      const { token, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(enforcer).freezePartialTokens(alice.address, 400n, REASON);

      await token.connect(enforcer).forcedTransfer(alice.address, bob.address, 100n, COURT_ORDER);
      expect(await token.getFrozenTokens(alice.address)).to.equal(400n);

      await expect(token.connect(enforcer).forcedTransfer(alice.address, bob.address, 150n, COURT_ORDER))
        .to.emit(token, "TokensUnfrozen")
        .withArgs(alice.address, 150n, enforcer.address, COURT_ORDER);
      expect(await token.getFrozenTokens(alice.address)).to.equal(250n);
      expect(await token.balanceOf(alice.address)).to.equal(250n);
    });

    it("cannot move more than the balance", async function () {
      const { token, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).forcedTransfer(alice.address, bob.address, 501n, COURT_ORDER))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(alice.address, 500n, 501n);
    });

    it("rejects a caller without the enforcer role", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await expect(
        token.connect(alice).forcedTransfer(bob.address, alice.address, 1n, COURT_ORDER),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("wallet recovery", function () {
    const LOST_KEY = encodeBytes32String("LOST_KEY");

    it("moves the balance, frozen amount and frozen flag to the investor's new wallet", async function () {
      const { token, enforcer, alice, aliceSecond, kyc } = await networkHelpers.loadFixture(fundedFixture);
      await kyc(aliceSecond, "alice");
      await token.connect(enforcer).freezePartialTokens(alice.address, 200n, REASON);
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);

      await expect(token.connect(enforcer).recoveryAddress(alice.address, aliceSecond.address, LOST_KEY))
        .to.emit(token, "RecoverySuccess")
        .withArgs(alice.address, aliceSecond.address, investorId("alice"), 500n, enforcer.address, LOST_KEY);

      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.getFrozenTokens(alice.address)).to.equal(0n);
      expect(await token.isFrozen(alice.address)).to.equal(false);
      expect(await token.balanceOf(aliceSecond.address)).to.equal(500n);
      expect(await token.getFrozenTokens(aliceSecond.address)).to.equal(200n);
      expect(await token.isFrozen(aliceSecond.address)).to.equal(true);
      expect(await token.holderCount()).to.equal(1n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(500n);
    });

    it("works while paused and when the lost wallet's identity was revoked", async function () {
      const { token, registry, registrar, enforcer, pauser, alice, aliceSecond, kyc } =
        await networkHelpers.loadFixture(fundedFixture);
      await kyc(aliceSecond, "alice");
      await registry.connect(registrar).revokeIdentity(alice.address, LOST_KEY);
      await token.connect(pauser).pause(REASON);
      await token.connect(enforcer).recoveryAddress(alice.address, aliceSecond.address, LOST_KEY);
      expect(await token.balanceOf(aliceSecond.address)).to.equal(500n);
    });

    it("rejects a new wallet that belongs to another investor", async function () {
      const { token, enforcer, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).recoveryAddress(alice.address, bob.address, LOST_KEY))
        .to.be.revertedWithCustomError(token, "InvestorMismatch")
        .withArgs(alice.address, bob.address);
    });

    it("rejects a lost wallet that was never registered", async function () {
      const { token, enforcer, bob, outsider } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).recoveryAddress(outsider.address, bob.address, LOST_KEY))
        .to.be.revertedWithCustomError(token, "InvestorMismatch")
        .withArgs(outsider.address, bob.address);
    });

    it("rejects an unverified new wallet and recovering a wallet onto itself", async function () {
      const { token, enforcer, alice, outsider } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).recoveryAddress(alice.address, outsider.address, LOST_KEY))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(outsider.address);
      await expect(
        token.connect(enforcer).recoveryAddress(alice.address, alice.address, LOST_KEY),
      ).to.be.revertedWithCustomError(token, "SameWallet");
    });

    it("rejects a caller without the enforcer role", async function () {
      const { token, alice, aliceSecond } = await networkHelpers.loadFixture(fundedFixture);
      await expect(
        token.connect(alice).recoveryAddress(alice.address, aliceSecond.address, LOST_KEY),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("pause", function () {
    it("blocks transfers, minting and burning, and resumes them", async function () {
      const { token, pauser, issuerOp, alice, bob, mint } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(pauser).pause(REASON))
        .to.emit(token, "PauseStateChanged")
        .withArgs(true, pauser.address, REASON);

      await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(mint(alice, 1n)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(issuerOp).burn(alice.address, 1n, REASON)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await expect(token.connect(pauser).unpause(REASON))
        .to.emit(token, "PauseStateChanged")
        .withArgs(false, pauser.address, REASON);
      await token.connect(alice).transfer(bob.address, 1n);
    });

    it("keeps freezing available while paused", async function () {
      const { token, pauser, enforcer, alice } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(pauser).pause(REASON);
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await token.connect(enforcer).freezePartialTokens(alice.address, 10n, REASON);
      expect(await token.getFrozenTokens(alice.address)).to.equal(10n);
    });

    it("rejects a caller without the pauser role", async function () {
      const { token, enforcer } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.connect(enforcer).pause(REASON)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(enforcer).unpause(REASON)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("investor aggregates", function () {
    it("tracks combined balances per investor and the number of holders", async function () {
      const { token, issuerOp, alice, aliceSecond, bob, kyc } = await networkHelpers.loadFixture(fundedFixture);
      await kyc(aliceSecond, "alice");
      expect(await token.holderCount()).to.equal(1n);

      await token.connect(alice).transfer(aliceSecond.address, 200n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(500n);
      expect(await token.holderCount()).to.equal(1n);

      await token.connect(alice).transfer(bob.address, 300n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(200n);
      expect(await token.investorBalanceOf(investorId("bob"))).to.equal(300n);
      expect(await token.holderCount()).to.equal(2n);

      await token.connect(aliceSecond).transfer(bob.address, 200n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(0n);
      expect(await token.holderCount()).to.equal(1n);

      await token.connect(issuerOp).burn(bob.address, 500n, REASON);
      expect(await token.holderCount()).to.equal(0n);
    });

    it("ignores zero-value and self transfers", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      await token.connect(alice).transfer(bob.address, 0n);
      await token.connect(bob).transfer(alice.address, 0n);
      await token.connect(alice).transfer(alice.address, 100n);
      expect(await token.holderCount()).to.equal(1n);
      expect(await token.investorBalanceOf(investorId("bob"))).to.equal(0n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(500n);
    });
  });

  describe("checkpoints", function () {
    it("reports balances and supply as of a past block", async function () {
      const { token, issuerOp, alice, bob } = await networkHelpers.loadFixture(fundedFixture);
      const afterMint = await ethers.provider.getBlockNumber();
      await token.connect(alice).transfer(bob.address, 200n);
      const afterTransfer = await ethers.provider.getBlockNumber();
      await token.connect(issuerOp).burn(alice.address, 100n, REASON);
      await networkHelpers.mine();

      expect(await token.balanceOfAt(alice.address, afterMint)).to.equal(500n);
      expect(await token.balanceOfAt(bob.address, afterMint)).to.equal(0n);
      expect(await token.totalSupplyAt(afterMint)).to.equal(500n);

      expect(await token.balanceOfAt(alice.address, afterTransfer)).to.equal(300n);
      expect(await token.balanceOfAt(bob.address, afterTransfer)).to.equal(200n);
      expect(await token.totalSupplyAt(afterTransfer)).to.equal(500n);

      expect(await token.balanceOfAt(alice.address, afterTransfer + 1)).to.equal(200n);
      expect(await token.totalSupplyAt(afterTransfer + 1)).to.equal(400n);
      expect(await token.balanceOfAt(alice.address, 0)).to.equal(0n);
    });
  });

  describe("compliance replacement", function () {
    it("lets the admin switch to a new compliance contract", async function () {
      const { token, compliance, admin, alice, mint } = await networkHelpers.loadFixture(fundedFixture);
      const open = await ethers.deployContract("ModularCompliance", [admin.address]);
      await expect(token.setCompliance(await open.getAddress()))
        .to.emit(token, "ComplianceSet")
        .withArgs(await compliance.getAddress(), await open.getAddress(), admin.address);
      await mint(alice, RETAIL_LIMIT * 2n);
      expect(await token.balanceOf(alice.address)).to.equal(500n + RETAIL_LIMIT * 2n);
    });

    it("rejects the zero address and non-admin callers", async function () {
      const { token, compliance, outsider } = await networkHelpers.loadFixture(fundedFixture);
      await expect(token.setCompliance(ZeroAddress)).to.be.revertedWithCustomError(token, "ZeroAddress");
      await expect(
        token.connect(outsider).setCompliance(await compliance.getAddress()),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("upgrade", function () {
    it("keeps balances, freezes, checkpoints, aggregates and roles", async function () {
      const { token, upgradesApi, upgrader, enforcer, issuerOp, alice, bob } =
        await networkHelpers.loadFixture(fundedFixture);
      await token.connect(alice).transfer(bob.address, 100n);
      const snapshotBlock = await ethers.provider.getBlockNumber();
      await token.connect(enforcer).freezePartialTokens(alice.address, 150n, REASON);
      await token.connect(enforcer).setAddressFrozen(bob.address, true, REASON);

      const v2Factory = await ethers.getContractFactory("SecurityTokenV2", upgrader);
      const proxyAddress = await token.getAddress();
      await upgradesApi.upgradeProxy(proxyAddress, v2Factory, { call: "initializeV2" });
      const upgraded = await ethers.getContractAt("SecurityTokenV2", proxyAddress);

      expect(await upgraded.version()).to.equal("2");
      expect(await upgraded.balanceOf(alice.address)).to.equal(400n);
      expect(await upgraded.getFrozenTokens(alice.address)).to.equal(150n);
      expect(await upgraded.isFrozen(bob.address)).to.equal(true);
      expect(await upgraded.balanceOfAt(alice.address, snapshotBlock)).to.equal(400n);
      expect(await upgraded.totalSupplyAt(snapshotBlock)).to.equal(500n);
      expect(await upgraded.holderCount()).to.equal(2n);
      expect(await upgraded.investorBalanceOf(investorId("bob"))).to.equal(100n);
      expect(await upgraded.registeredSupply()).to.equal(REGISTERED_SUPPLY);
      expect(await upgraded.hasRole(ISSUER_ROLE, issuerOp.address)).to.equal(true);
    });

    it("rejects an upgrade from an account without the upgrader role", async function () {
      const { token, admin } = await networkHelpers.loadFixture(fundedFixture);
      const implementation = await ethers.deployContract("SecurityTokenV2");
      await expect(token.connect(admin).upgradeToAndCall(await implementation.getAddress(), "0x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, UPGRADER_ROLE);
    });
  });
});
