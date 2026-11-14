import { expect } from "chai";
import { encodeBytes32String, ZeroAddress } from "ethers";
import { network } from "hardhat";
import { deploySystem, REASON } from "./helpers/system.js";
import { SETTLEMENT_ROLE, signTrade, tradeId, type TradeTerms } from "./helpers/trade.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const QUANTITY = 10n;
const PRICE = 1_000_000_000n; // 1,000 USDC

describe("DvPSettlement", function () {
  async function fixture() {
    const system = await deploySystem(connection);
    const { admin, alice, bob, token, kyc, mint } = system;
    const [, , , , , , , , , , , , , , , settler] = await ethers.getSigners();

    const usdc = await ethers.deployContract("USDC");
    const dvp = await ethers.deployContract("DvPSettlement", [admin.address]);
    await dvp.grantRole(SETTLEMENT_ROLE, settler.address);
    await dvp.setSecurityAllowed(await token.getAddress(), true);
    await dvp.setCashAllowed(await usdc.getAddress(), true);

    await kyc(alice, "alice");
    await kyc(bob, "bob");
    await mint(alice, 100n);
    await usdc.mint(bob.address, PRICE * 5n);
    await token.connect(alice).approve(await dvp.getAddress(), QUANTITY);
    await usdc.connect(bob).approve(await dvp.getAddress(), PRICE);

    const now = BigInt(await networkHelpers.time.latest());
    const terms: TradeTerms = {
      tradeId: tradeId("OTC-20270104-0001"),
      seller: alice.address,
      buyer: bob.address,
      security: await token.getAddress(),
      cash: await usdc.getAddress(),
      quantity: QUANTITY,
      price: PRICE,
      expiry: now + 3600n,
    };

    /** Registers `t` with signatures from the given parties (seller and buyer by default). */
    async function create(t: TradeTerms = terms, sellerSigner = alice, buyerSigner = bob) {
      const sellerSignature = await signTrade(sellerSigner, dvp, t);
      const buyerSignature = await signTrade(buyerSigner, dvp, t);
      return dvp.connect(settler).createTrade(t, sellerSignature, buyerSignature);
    }

    return { ...system, usdc, dvp, settler, terms, create };
  }

  describe("configuration", function () {
    it("rejects a zero admin", async function () {
      const factory = await ethers.getContractFactory("DvPSettlement");
      await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("lets only the admin manage the allowed tokens", async function () {
      const { dvp, admin, settler, usdc } = await networkHelpers.loadFixture(fixture);
      const address = await usdc.getAddress();
      await expect(dvp.setSecurityAllowed(address, true))
        .to.emit(dvp, "SecurityAllowed")
        .withArgs(address, true, admin.address);
      await expect(dvp.setCashAllowed(address, false)).to.emit(dvp, "CashAllowed").withArgs(address, false, admin.address);
      expect(await dvp.isSecurityAllowed(address)).to.equal(true);
      expect(await dvp.isCashAllowed(address)).to.equal(false);

      await expect(dvp.connect(settler).setSecurityAllowed(address, true)).to.be.revertedWithCustomError(
        dvp,
        "AccessControlUnauthorizedAccount",
      );
      await expect(dvp.connect(settler).setCashAllowed(address, true)).to.be.revertedWithCustomError(
        dvp,
        "AccessControlUnauthorizedAccount",
      );
      await expect(dvp.setSecurityAllowed(ZeroAddress, true)).to.be.revertedWithCustomError(dvp, "ZeroAddress");
      await expect(dvp.setCashAllowed(ZeroAddress, true)).to.be.revertedWithCustomError(dvp, "ZeroAddress");
    });
  });

  describe("trade registration", function () {
    it("registers a trade signed by both parties", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await expect(create())
        .to.emit(dvp, "TradeCreated")
        .withArgs(
          terms.tradeId,
          terms.seller,
          terms.buyer,
          terms.security,
          terms.cash,
          terms.quantity,
          terms.price,
          terms.expiry,
          settler.address,
        );
      const trade = await dvp.getTrade(terms.tradeId);
      expect(trade.status).to.equal(1n);
      expect(trade.quantity).to.equal(QUANTITY);
      expect(trade.price).to.equal(PRICE);
    });

    it("rejects a trade number that was already used", async function () {
      const { dvp, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await expect(create()).to.be.revertedWithCustomError(dvp, "TradeExists").withArgs(terms.tradeId);
    });

    it("rejects terms the seller did not sign", async function () {
      const { dvp, alice, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await expect(create(terms, bob, bob)).to.be.revertedWithCustomError(dvp, "InvalidSignature").withArgs(alice.address);
    });

    it("rejects terms the buyer did not sign", async function () {
      const { dvp, alice, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await expect(create(terms, alice, alice))
        .to.be.revertedWithCustomError(dvp, "InvalidSignature")
        .withArgs(bob.address);
    });

    it("rejects a price that differs from the signed price", async function () {
      const { dvp, settler, alice, bob, terms } = await networkHelpers.loadFixture(fixture);
      const sellerSignature = await signTrade(alice, dvp, terms);
      const buyerSignature = await signTrade(bob, dvp, terms);
      const altered = { ...terms, price: 1n };
      await expect(
        dvp.connect(settler).createTrade(altered, sellerSignature, buyerSignature),
      ).to.be.revertedWithCustomError(dvp, "InvalidSignature");
    });

    it("rejects tokens that are not allowed", async function () {
      const { dvp, usdc, token, terms, create } = await networkHelpers.loadFixture(fixture);
      const other = await ethers.deployContract("USDC");
      await expect(create({ ...terms, cash: await other.getAddress() }))
        .to.be.revertedWithCustomError(dvp, "TokenNotAllowed")
        .withArgs(await other.getAddress());
      await expect(create({ ...terms, security: await usdc.getAddress() }))
        .to.be.revertedWithCustomError(dvp, "TokenNotAllowed")
        .withArgs(await usdc.getAddress());
      await dvp.setSecurityAllowed(await token.getAddress(), false);
      await expect(create()).to.be.revertedWithCustomError(dvp, "TokenNotAllowed");
    });

    it("rejects invalid terms", async function () {
      const { dvp, alice, terms, create } = await networkHelpers.loadFixture(fixture);
      await expect(create({ ...terms, quantity: 0n })).to.be.revertedWithCustomError(dvp, "InvalidTerms");
      await expect(create({ ...terms, buyer: alice.address })).to.be.revertedWithCustomError(dvp, "InvalidTerms");
      await expect(create({ ...terms, seller: ZeroAddress })).to.be.revertedWithCustomError(dvp, "InvalidTerms");
      await expect(create({ ...terms, buyer: ZeroAddress })).to.be.revertedWithCustomError(dvp, "InvalidTerms");
    });

    it("rejects terms that have already expired", async function () {
      const { dvp, terms, create } = await networkHelpers.loadFixture(fixture);
      const expired = { ...terms, expiry: BigInt(await networkHelpers.time.latest()) };
      await expect(create(expired)).to.be.revertedWithCustomError(dvp, "TradeExpired");
    });

    it("rejects a caller without the settlement role", async function () {
      const { dvp, alice, bob, terms } = await networkHelpers.loadFixture(fixture);
      const sellerSignature = await signTrade(alice, dvp, terms);
      const buyerSignature = await signTrade(bob, dvp, terms);
      await expect(
        dvp.connect(alice).createTrade(terms, sellerSignature, buyerSignature),
      ).to.be.revertedWithCustomError(dvp, "AccessControlUnauthorizedAccount");
    });
  });

  describe("settlement", function () {
    it("exchanges securities and cash in one transaction", async function () {
      const { dvp, token, usdc, settler, alice, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await expect(dvp.connect(settler).settle(terms.tradeId))
        .to.emit(dvp, "TradeSettled")
        .withArgs(terms.tradeId, settler.address);

      expect(await token.balanceOf(alice.address)).to.equal(90n);
      expect(await token.balanceOf(bob.address)).to.equal(QUANTITY);
      expect(await usdc.balanceOf(alice.address)).to.equal(PRICE);
      expect(await usdc.balanceOf(bob.address)).to.equal(PRICE * 4n);
      expect((await dvp.getTrade(terms.tradeId)).status).to.equal(2n);
    });

    it("cannot settle the same trade twice", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await dvp.connect(settler).settle(terms.tradeId);
      await expect(dvp.connect(settler).settle(terms.tradeId))
        .to.be.revertedWithCustomError(dvp, "InvalidStatus")
        .withArgs(terms.tradeId, 2n);
    });

    it("moves nothing when the buyer's identity is revoked before settlement", async function () {
      const { dvp, token, usdc, registry, registrar, settler, alice, bob, terms, create } =
        await networkHelpers.loadFixture(fixture);
      await create();
      await registry.connect(registrar).revokeIdentity(bob.address, REASON);

      await expect(dvp.connect(settler).settle(terms.tradeId))
        .to.be.revertedWithCustomError(token, "NotVerified")
        .withArgs(bob.address);
      expect(await token.balanceOf(alice.address)).to.equal(100n);
      expect(await usdc.balanceOf(bob.address)).to.equal(PRICE * 5n);
      expect((await dvp.getTrade(terms.tradeId)).status).to.equal(1n);
    });

    it("moves nothing when the cash leg fails", async function () {
      const { dvp, token, usdc, settler, alice, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await usdc.connect(bob).approve(await dvp.getAddress(), PRICE - 1n);

      await expect(dvp.connect(settler).settle(terms.tradeId)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientAllowance",
      );
      expect(await token.balanceOf(alice.address)).to.equal(100n);
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });

    it("moves nothing when a compliance rule rejects the delivery", async function () {
      const { dvp, token, usdc, maxBalance, settler, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await maxBalance.setMaxBalance(0, QUANTITY - 1n);
      await expect(dvp.connect(settler).settle(terms.tradeId)).to.be.revertedWithCustomError(
        token,
        "ComplianceRejected",
      );
      expect(await usdc.balanceOf(bob.address)).to.equal(PRICE * 5n);
    });

    it("can be retried after the cause of a failure is fixed", async function () {
      const { dvp, token, enforcer, settler, alice, bob, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await token.connect(enforcer).setAddressFrozen(alice.address, true, REASON);
      await expect(dvp.connect(settler).settle(terms.tradeId)).to.be.revertedWithCustomError(token, "AccountFrozen");
      await token.connect(enforcer).setAddressFrozen(alice.address, false, REASON);
      await dvp.connect(settler).settle(terms.tradeId);
      expect(await token.balanceOf(bob.address)).to.equal(QUANTITY);
    });

    it("cannot settle after expiry", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await networkHelpers.time.increaseTo(terms.expiry + 1n);
      await expect(dvp.connect(settler).settle(terms.tradeId))
        .to.be.revertedWithCustomError(dvp, "TradeExpired")
        .withArgs(terms.tradeId, terms.expiry);
    });

    it("rejects an unknown trade and a caller without the settlement role", async function () {
      const { dvp, settler, alice, terms, create } = await networkHelpers.loadFixture(fixture);
      await expect(dvp.connect(settler).settle(tradeId("UNKNOWN")))
        .to.be.revertedWithCustomError(dvp, "InvalidStatus")
        .withArgs(tradeId("UNKNOWN"), 0n);
      await create();
      await expect(dvp.connect(alice).settle(terms.tradeId)).to.be.revertedWithCustomError(
        dvp,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("cancellation", function () {
    const CANCEL_REASON = encodeBytes32String("COUNTERPARTY_REQUEST");

    it("cancels a pending trade and blocks later settlement", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await expect(dvp.connect(settler).cancel(terms.tradeId, CANCEL_REASON))
        .to.emit(dvp, "TradeCancelled")
        .withArgs(terms.tradeId, settler.address, CANCEL_REASON);
      await expect(dvp.connect(settler).settle(terms.tradeId))
        .to.be.revertedWithCustomError(dvp, "InvalidStatus")
        .withArgs(terms.tradeId, 3n);
    });

    it("cancels an expired trade", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await networkHelpers.time.increaseTo(terms.expiry + 1n);
      await dvp.connect(settler).cancel(terms.tradeId, CANCEL_REASON);
      expect((await dvp.getTrade(terms.tradeId)).status).to.equal(3n);
    });

    it("cannot cancel a settled trade or reuse a cancelled trade number", async function () {
      const { dvp, settler, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await dvp.connect(settler).settle(terms.tradeId);
      await expect(dvp.connect(settler).cancel(terms.tradeId, CANCEL_REASON)).to.be.revertedWithCustomError(
        dvp,
        "InvalidStatus",
      );
      await expect(create()).to.be.revertedWithCustomError(dvp, "TradeExists");
    });

    it("rejects a caller without the settlement role", async function () {
      const { dvp, alice, terms, create } = await networkHelpers.loadFixture(fixture);
      await create();
      await expect(dvp.connect(alice).cancel(terms.tradeId, CANCEL_REASON)).to.be.revertedWithCustomError(
        dvp,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});
