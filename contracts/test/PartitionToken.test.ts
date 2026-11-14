import { expect } from "chai";
import { encodeBytes32String, id, ZeroAddress, ZeroHash } from "ethers";
import { network } from "hardhat";
import { deploySystem, ISSUER_ROLE, PAUSER_ROLE, REASON } from "./helpers/system.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const CONTROLLER_ROLE = id("CONTROLLER_ROLE");
const GENERAL = encodeBytes32String("GENERAL");
const LOCKUP = encodeBytes32String("LOCKUP");
const DAY = 24 * 60 * 60;

const SUCCESS = "0x51";
const INSUFFICIENT_BALANCE = "0x52";
const TRANSFERS_HALTED = "0x54";
const FUNDS_LOCKED = "0x55";
const INVALID_SENDER = "0x56";
const INVALID_RECEIVER = "0x57";
const INVALID_OPERATOR = "0x58";

describe("PartitionToken", function () {
  async function fixture() {
    const system = await deploySystem(connection);
    const { admin, registry, issuerOp, enforcer, pauser, alice, bob, kyc } = system;
    const token = await ethers.deployContract("PartitionToken", [
      "Example Preferred Unit",
      "EPU",
      admin.address,
      await registry.getAddress(),
    ]);
    await token.grantRole(ISSUER_ROLE, issuerOp.address);
    await token.grantRole(CONTROLLER_ROLE, enforcer.address);
    await token.grantRole(PAUSER_ROLE, pauser.address);
    await kyc(alice, "alice");
    await kyc(bob, "bob");

    const issue = (partition: string, to: string, value: bigint) =>
      token.connect(issuerOp).issueByPartition(partition, to, value, "0x");
    await issue(GENERAL, alice.address, 100n);
    await issue(LOCKUP, alice.address, 50n);

    const check = async (operator: string, from: string, to: string, partition: string, value: bigint) => {
      const [code, reason] = await token.canTransferByPartition(operator, from, to, partition, value);
      return { code, reason };
    };
    return { ...system, partitionToken: token, issue, check, controller: enforcer };
  }

  describe("deployment", function () {
    it("sets metadata and the partition constants", async function () {
      const { partitionToken, registry } = await networkHelpers.loadFixture(fixture);
      expect(await partitionToken.name()).to.equal("Example Preferred Unit");
      expect(await partitionToken.symbol()).to.equal("EPU");
      expect(await partitionToken.decimals()).to.equal(0n);
      expect(await partitionToken.identityRegistry()).to.equal(await registry.getAddress());
      expect(await partitionToken.DEFAULT_PARTITION()).to.equal(GENERAL);
      expect(await partitionToken.LOCKUP_PARTITION()).to.equal(LOCKUP);
      expect(await partitionToken.isControllable()).to.equal(true);
    });

    it("rejects a zero admin or registry", async function () {
      const { registry, admin } = await networkHelpers.loadFixture(fixture);
      const factory = await ethers.getContractFactory("PartitionToken");
      await expect(factory.deploy("x", "x", ZeroAddress, await registry.getAddress())).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
      await expect(factory.deploy("x", "x", admin.address, ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
    });
  });

  describe("balances by partition", function () {
    it("tracks balances, supply and the partitions of a holder", async function () {
      const { partitionToken, alice } = await networkHelpers.loadFixture(fixture);
      expect(await partitionToken.balanceOf(alice.address)).to.equal(150n);
      expect(await partitionToken.balanceOfByPartition(GENERAL, alice.address)).to.equal(100n);
      expect(await partitionToken.balanceOfByPartition(LOCKUP, alice.address)).to.equal(50n);
      expect(await partitionToken.totalSupply()).to.equal(150n);
      expect(await partitionToken.totalSupplyByPartition(GENERAL)).to.equal(100n);
      expect(await partitionToken.totalSupplyByPartition(LOCKUP)).to.equal(50n);
      expect(await partitionToken.partitionsOf(alice.address)).to.deep.equal([GENERAL, LOCKUP]);
    });

    it("drops a partition from the holder's list when its balance reaches zero", async function () {
      const { partitionToken, alice, bob } = await networkHelpers.loadFixture(fixture);
      await partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 100n, "0x");
      expect(await partitionToken.partitionsOf(alice.address)).to.deep.equal([LOCKUP]);
      expect(await partitionToken.partitionsOf(bob.address)).to.deep.equal([GENERAL]);
      await partitionToken.connect(alice).transferByPartition(LOCKUP, bob.address, 50n, "0x");
      expect(await partitionToken.partitionsOf(alice.address)).to.deep.equal([]);
      expect(await partitionToken.partitionsOf(bob.address)).to.deep.equal([GENERAL, LOCKUP]);
    });
  });

  describe("issuance", function () {
    it("emits the issuance event", async function () {
      const { partitionToken, issuerOp, bob } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(issuerOp).issueByPartition(GENERAL, bob.address, 10n, "0x1234"))
        .to.emit(partitionToken, "IssuedByPartition")
        .withArgs(GENERAL, issuerOp.address, bob.address, 10n, "0x1234");
    });

    it("rejects unverified, zero and frozen receivers", async function () {
      const { partitionToken, controller, bob, outsider, issue } = await networkHelpers.loadFixture(fixture);
      await expect(issue(GENERAL, outsider.address, 1n))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_RECEIVER, encodeBytes32String("RECEIVER_NOT_VERIFIED"));
      await expect(issue(GENERAL, ZeroAddress, 1n)).to.be.revertedWithCustomError(partitionToken, "TransferRejected");
      await partitionToken.connect(controller).setAddressFrozen(bob.address, true, REASON);
      await expect(issue(GENERAL, bob.address, 1n))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_RECEIVER, encodeBytes32String("RECEIVER_FROZEN"));
    });

    it("can be closed permanently", async function () {
      const { partitionToken, issuerOp, alice, issue } = await networkHelpers.loadFixture(fixture);
      expect(await partitionToken.isIssuable()).to.equal(true);
      await expect(partitionToken.connect(issuerOp).closeIssuance())
        .to.emit(partitionToken, "IssuanceClosed")
        .withArgs(issuerOp.address);
      expect(await partitionToken.isIssuable()).to.equal(false);
      await expect(issue(GENERAL, alice.address, 1n)).to.be.revertedWithCustomError(partitionToken, "IssuanceIsClosed");
    });

    it("rejects callers without the issuer role", async function () {
      const { partitionToken, alice } = await networkHelpers.loadFixture(fixture);
      await expect(
        partitionToken.connect(alice).issueByPartition(GENERAL, alice.address, 1n, "0x"),
      ).to.be.revertedWithCustomError(partitionToken, "AccessControlUnauthorizedAccount");
      await expect(partitionToken.connect(alice).closeIssuance()).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("transfer validation", function () {
    it("returns 0x51 for a transfer that would succeed", async function () {
      const { partitionToken, alice, bob } = await networkHelpers.loadFixture(fixture);
      const [code, reason, destination] = await partitionToken.canTransferByPartition(
        alice.address,
        alice.address,
        bob.address,
        GENERAL,
        10n,
      );
      expect(code).to.equal(SUCCESS);
      expect(reason).to.equal(ZeroHash);
      expect(destination).to.equal(GENERAL);
    });

    it("returns 0x52 when the partition balance is too small", async function () {
      const { alice, bob, check } = await networkHelpers.loadFixture(fixture);
      expect((await check(alice.address, alice.address, bob.address, GENERAL, 101n)).code).to.equal(
        INSUFFICIENT_BALANCE,
      );
    });

    it("returns 0x54 while paused", async function () {
      const { partitionToken, pauser, alice, bob, check } = await networkHelpers.loadFixture(fixture);
      await partitionToken.connect(pauser).pause();
      expect((await check(alice.address, alice.address, bob.address, GENERAL, 1n)).code).to.equal(TRANSFERS_HALTED);
    });

    it("returns 0x55 while the partition is locked up", async function () {
      const { partitionToken, issuerOp, alice, bob, check } = await networkHelpers.loadFixture(fixture);
      const until = BigInt(await networkHelpers.time.latest()) + BigInt(30 * DAY);
      await partitionToken.connect(issuerOp).setLockup(LOCKUP, until);
      const result = await check(alice.address, alice.address, bob.address, LOCKUP, 1n);
      expect(result.code).to.equal(FUNDS_LOCKED);
      expect(result.reason).to.equal(encodeBytes32String("PARTITION_LOCKED"));
      expect((await check(alice.address, alice.address, bob.address, GENERAL, 1n)).code).to.equal(SUCCESS);
    });

    it("returns 0x56 for a frozen or unverified sender", async function () {
      const { partitionToken, registry, registrar, controller, alice, bob, check } =
        await networkHelpers.loadFixture(fixture);
      await partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON);
      expect((await check(alice.address, alice.address, bob.address, GENERAL, 1n)).reason).to.equal(
        encodeBytes32String("SENDER_FROZEN"),
      );
      await partitionToken.connect(controller).setAddressFrozen(alice.address, false, REASON);
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      const result = await check(alice.address, alice.address, bob.address, GENERAL, 1n);
      expect(result.code).to.equal(INVALID_SENDER);
      expect(result.reason).to.equal(encodeBytes32String("SENDER_NOT_VERIFIED"));
    });

    it("returns 0x57 for an unverified, zero or frozen receiver", async function () {
      const { partitionToken, controller, alice, bob, outsider, check } = await networkHelpers.loadFixture(fixture);
      expect((await check(alice.address, alice.address, outsider.address, GENERAL, 1n)).code).to.equal(
        INVALID_RECEIVER,
      );
      expect((await check(alice.address, alice.address, ZeroAddress, GENERAL, 1n)).code).to.equal(INVALID_RECEIVER);
      await partitionToken.connect(controller).setAddressFrozen(bob.address, true, REASON);
      expect((await check(alice.address, alice.address, bob.address, GENERAL, 1n)).reason).to.equal(
        encodeBytes32String("RECEIVER_FROZEN"),
      );
    });

    it("returns 0x58 for an operator the holder has not authorised", async function () {
      const { alice, bob, check } = await networkHelpers.loadFixture(fixture);
      expect((await check(bob.address, alice.address, bob.address, GENERAL, 1n)).code).to.equal(INVALID_OPERATOR);
    });
  });

  describe("transfers", function () {
    it("moves a partition balance and emits the event", async function () {
      const { partitionToken, alice, bob } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 40n, "0xabcd"))
        .to.emit(partitionToken, "TransferByPartition")
        .withArgs(GENERAL, alice.address, alice.address, bob.address, 40n, "0xabcd", "0x");
      expect(await partitionToken.balanceOfByPartition(GENERAL, alice.address)).to.equal(60n);
      expect(await partitionToken.balanceOfByPartition(GENERAL, bob.address)).to.equal(40n);
      expect(await partitionToken.totalSupply()).to.equal(150n);
    });

    it("reverts with the reason code when validation fails", async function () {
      const { partitionToken, alice, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(alice).transferByPartition(GENERAL, outsider.address, 1n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_RECEIVER, encodeBytes32String("RECEIVER_NOT_VERIFIED"));
    });

    it("lets an authorised operator move a holder's balance until revoked", async function () {
      const { partitionToken, alice, bob, carol } = await networkHelpers.loadFixture(fixture);
      await expect(
        partitionToken.connect(carol).operatorTransferByPartition(GENERAL, alice.address, bob.address, 1n, "0x", "0x"),
      )
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_OPERATOR, encodeBytes32String("OPERATOR_NOT_AUTHORIZED"));

      await expect(partitionToken.connect(alice).authorizeOperator(carol.address))
        .to.emit(partitionToken, "AuthorizedOperator")
        .withArgs(carol.address, alice.address);
      expect(await partitionToken.isOperator(carol.address, alice.address)).to.equal(true);
      expect(await partitionToken.isOperator(alice.address, alice.address)).to.equal(true);

      await expect(
        partitionToken.connect(carol).operatorTransferByPartition(GENERAL, alice.address, bob.address, 5n, "0x", "0x01"),
      )
        .to.emit(partitionToken, "TransferByPartition")
        .withArgs(GENERAL, carol.address, alice.address, bob.address, 5n, "0x", "0x01");

      await expect(partitionToken.connect(alice).revokeOperator(carol.address))
        .to.emit(partitionToken, "RevokedOperator")
        .withArgs(carol.address, alice.address);
      expect(await partitionToken.isOperator(carol.address, alice.address)).to.equal(false);
      await expect(
        partitionToken.connect(carol).operatorTransferByPartition(GENERAL, alice.address, bob.address, 1n, "0x", "0x"),
      ).to.be.revertedWithCustomError(partitionToken, "TransferRejected");
    });
  });

  describe("lock-up and conversion", function () {
    async function lockedFixture() {
      const system = await fixture();
      const until = BigInt(await networkHelpers.time.latest()) + BigInt(30 * DAY);
      await system.partitionToken.connect(system.issuerOp).setLockup(LOCKUP, until);
      await system.partitionToken.connect(system.issuerOp).setConversion(LOCKUP, GENERAL);
      return { ...system, until };
    }

    it("records the lock-up and the conversion target", async function () {
      const { partitionToken, issuerOp, until } = await networkHelpers.loadFixture(lockedFixture);
      expect(await partitionToken.lockedUntil(LOCKUP)).to.equal(until);
      expect(await partitionToken.conversionTarget(LOCKUP)).to.equal(GENERAL);
      await expect(partitionToken.connect(issuerOp).setLockup(LOCKUP, until + 1n))
        .to.emit(partitionToken, "LockupSet")
        .withArgs(LOCKUP, until + 1n, issuerOp.address);
      await expect(partitionToken.connect(issuerOp).setConversion(LOCKUP, GENERAL))
        .to.emit(partitionToken, "ConversionSet")
        .withArgs(LOCKUP, GENERAL, issuerOp.address);
    });

    it("blocks transfer, conversion and redemption during the lock-up", async function () {
      const { partitionToken, issuerOp, alice, bob, until } = await networkHelpers.loadFixture(lockedFixture);
      await expect(partitionToken.connect(alice).transferByPartition(LOCKUP, bob.address, 1n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(FUNDS_LOCKED, encodeBytes32String("PARTITION_LOCKED"));
      await expect(partitionToken.connect(alice).convertPartition(LOCKUP, 1n))
        .to.be.revertedWithCustomError(partitionToken, "PartitionLocked")
        .withArgs(LOCKUP, until);
      await expect(partitionToken.connect(issuerOp).redeemByPartition(LOCKUP, alice.address, 1n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(FUNDS_LOCKED, encodeBytes32String("PARTITION_LOCKED"));
    });

    it("lets the holder convert locked units into general units after the lock-up", async function () {
      const { partitionToken, alice, bob, until } = await networkHelpers.loadFixture(lockedFixture);
      await networkHelpers.time.increaseTo(until);
      await expect(partitionToken.connect(alice).convertPartition(LOCKUP, 50n))
        .to.emit(partitionToken, "PartitionConverted")
        .withArgs(LOCKUP, GENERAL, alice.address, 50n);

      expect(await partitionToken.balanceOfByPartition(LOCKUP, alice.address)).to.equal(0n);
      expect(await partitionToken.balanceOfByPartition(GENERAL, alice.address)).to.equal(150n);
      expect(await partitionToken.totalSupplyByPartition(LOCKUP)).to.equal(0n);
      expect(await partitionToken.totalSupplyByPartition(GENERAL)).to.equal(150n);
      expect(await partitionToken.totalSupply()).to.equal(150n);
      expect(await partitionToken.partitionsOf(alice.address)).to.deep.equal([GENERAL]);
      await partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 150n, "0x");
    });

    it("rejects conversion without a target, beyond the balance, while paused or frozen", async function () {
      const { partitionToken, pauser, controller, alice, until } = await networkHelpers.loadFixture(lockedFixture);
      await networkHelpers.time.increaseTo(until);
      await expect(partitionToken.connect(alice).convertPartition(GENERAL, 1n))
        .to.be.revertedWithCustomError(partitionToken, "NoConversionConfigured")
        .withArgs(GENERAL);
      await expect(partitionToken.connect(alice).convertPartition(LOCKUP, 51n))
        .to.be.revertedWithCustomError(partitionToken, "InsufficientPartitionBalance")
        .withArgs(alice.address, LOCKUP, 50n, 51n);

      await partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON);
      await expect(partitionToken.connect(alice).convertPartition(LOCKUP, 1n))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_SENDER, encodeBytes32String("SENDER_FROZEN"));
      await partitionToken.connect(pauser).pause();
      await expect(partitionToken.connect(alice).convertPartition(LOCKUP, 1n)).to.be.revertedWithCustomError(
        partitionToken,
        "EnforcedPause",
      );
    });

    it("rejects lock-up and conversion changes from non-issuers", async function () {
      const { partitionToken, alice } = await networkHelpers.loadFixture(lockedFixture);
      await expect(partitionToken.connect(alice).setLockup(LOCKUP, 0)).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
      await expect(partitionToken.connect(alice).setConversion(LOCKUP, GENERAL)).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("redemption", function () {
    it("redeems from a partition and emits the event", async function () {
      const { partitionToken, issuerOp, alice } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(issuerOp).redeemByPartition(GENERAL, alice.address, 30n, "0x"))
        .to.emit(partitionToken, "RedeemedByPartition")
        .withArgs(GENERAL, issuerOp.address, alice.address, 30n, "0x");
      expect(await partitionToken.balanceOf(alice.address)).to.equal(120n);
      expect(await partitionToken.totalSupply()).to.equal(120n);
      expect(await partitionToken.totalSupplyByPartition(GENERAL)).to.equal(70n);
    });

    it("rejects redemption from a frozen account, beyond the balance, or by a non-issuer", async function () {
      const { partitionToken, issuerOp, controller, alice } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(issuerOp).redeemByPartition(GENERAL, alice.address, 101n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "InsufficientPartitionBalance")
        .withArgs(alice.address, GENERAL, 100n, 101n);
      await expect(
        partitionToken.connect(alice).redeemByPartition(GENERAL, alice.address, 1n, "0x"),
      ).to.be.revertedWithCustomError(partitionToken, "AccessControlUnauthorizedAccount");
      await partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON);
      await expect(partitionToken.connect(issuerOp).redeemByPartition(GENERAL, alice.address, 1n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_SENDER, encodeBytes32String("SENDER_FROZEN"));
    });
  });

  describe("controller operations", function () {
    it("forces a transfer regardless of pause, freeze and lock-up", async function () {
      const { partitionToken, issuerOp, pauser, controller, alice, bob } = await networkHelpers.loadFixture(fixture);
      const until = BigInt(await networkHelpers.time.latest()) + BigInt(30 * DAY);
      await partitionToken.connect(issuerOp).setLockup(LOCKUP, until);
      await partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON);
      await partitionToken.connect(pauser).pause();

      await expect(
        partitionToken
          .connect(controller)
          .controllerTransferByPartition(LOCKUP, alice.address, bob.address, 50n, "0x", "0x01"),
      )
        .to.emit(partitionToken, "ControllerTransfer")
        .withArgs(controller.address, alice.address, bob.address, 50n, "0x", "0x01")
        .and.to.emit(partitionToken, "TransferByPartition");
      expect(await partitionToken.balanceOfByPartition(LOCKUP, bob.address)).to.equal(50n);
    });

    it("requires a verified receiver for a forced transfer", async function () {
      const { partitionToken, controller, alice, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(
        partitionToken
          .connect(controller)
          .controllerTransferByPartition(GENERAL, alice.address, outsider.address, 1n, "0x", "0x"),
      )
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(INVALID_RECEIVER, encodeBytes32String("RECEIVER_NOT_VERIFIED"));
      await expect(
        partitionToken.connect(controller).controllerTransferByPartition(GENERAL, alice.address, ZeroAddress, 1n, "0x", "0x"),
      ).to.be.revertedWithCustomError(partitionToken, "TransferRejected");
    });

    it("forces a redemption from a frozen account", async function () {
      const { partitionToken, controller, alice } = await networkHelpers.loadFixture(fixture);
      await partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON);
      await expect(
        partitionToken.connect(controller).controllerRedeemByPartition(GENERAL, alice.address, 100n, "0x", "0x02"),
      )
        .to.emit(partitionToken, "ControllerRedemption")
        .withArgs(controller.address, alice.address, 100n, "0x", "0x02");
      expect(await partitionToken.totalSupply()).to.equal(50n);
    });

    it("freezes and unfreezes accounts with an event", async function () {
      const { partitionToken, controller, alice } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(controller).setAddressFrozen(alice.address, true, REASON))
        .to.emit(partitionToken, "AddressFrozen")
        .withArgs(alice.address, true, controller.address, REASON);
      expect(await partitionToken.isFrozen(alice.address)).to.equal(true);
    });

    it("rejects callers without the controller role", async function () {
      const { partitionToken, issuerOp, alice, bob } = await networkHelpers.loadFixture(fixture);
      const unauthorized = partitionToken.connect(issuerOp);
      for (const call of [
        unauthorized.controllerTransferByPartition(GENERAL, alice.address, bob.address, 1n, "0x", "0x"),
        unauthorized.controllerRedeemByPartition(GENERAL, alice.address, 1n, "0x", "0x"),
        unauthorized.setAddressFrozen(alice.address, true, REASON),
      ]) {
        await expect(call).to.be.revertedWithCustomError(partitionToken, "AccessControlUnauthorizedAccount");
      }
    });
  });

  describe("pause", function () {
    it("blocks holder transfers until resumed and is limited to the pauser", async function () {
      const { partitionToken, pauser, alice, bob } = await networkHelpers.loadFixture(fixture);
      await expect(partitionToken.connect(alice).pause()).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
      await partitionToken.connect(pauser).pause();
      await expect(partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 1n, "0x"))
        .to.be.revertedWithCustomError(partitionToken, "TransferRejected")
        .withArgs(TRANSFERS_HALTED, encodeBytes32String("PAUSED"));
      await expect(partitionToken.connect(alice).unpause()).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
      await partitionToken.connect(pauser).unpause();
      await partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 1n, "0x");
    });
  });

  describe("documents", function () {
    const PROSPECTUS = encodeBytes32String("PROSPECTUS");
    const TERMS = encodeBytes32String("TERMS");
    const HASH_A = id("prospectus-v1");
    const HASH_B = id("prospectus-v2");

    it("attaches, updates, lists and removes documents", async function () {
      const { partitionToken, issuerOp } = await networkHelpers.loadFixture(fixture);
      const issuerToken = partitionToken.connect(issuerOp);
      await expect(issuerToken.setDocument(PROSPECTUS, "ipfs://prospectus-v1", HASH_A))
        .to.emit(partitionToken, "DocumentUpdated")
        .withArgs(PROSPECTUS, "ipfs://prospectus-v1", HASH_A);
      await issuerToken.setDocument(TERMS, "ipfs://terms", id("terms"));
      await issuerToken.setDocument(PROSPECTUS, "ipfs://prospectus-v2", HASH_B);

      const [uri, hash, timestamp] = await partitionToken.getDocument(PROSPECTUS);
      expect(uri).to.equal("ipfs://prospectus-v2");
      expect(hash).to.equal(HASH_B);
      expect(timestamp).to.equal(BigInt(await networkHelpers.time.latest()));
      expect(await partitionToken.getAllDocuments()).to.deep.equal([PROSPECTUS, TERMS]);

      await expect(issuerToken.removeDocument(PROSPECTUS))
        .to.emit(partitionToken, "DocumentRemoved")
        .withArgs(PROSPECTUS, "ipfs://prospectus-v2", HASH_B);
      expect(await partitionToken.getAllDocuments()).to.deep.equal([TERMS]);
      expect((await partitionToken.getDocument(PROSPECTUS))[0]).to.equal("");

      await issuerToken.removeDocument(TERMS);
      expect(await partitionToken.getAllDocuments()).to.deep.equal([]);
    });

    it("rejects invalid documents, unknown removals and non-issuers", async function () {
      const { partitionToken, issuerOp, alice } = await networkHelpers.loadFixture(fixture);
      const issuerToken = partitionToken.connect(issuerOp);
      await expect(issuerToken.setDocument(ZeroHash, "ipfs://x", HASH_A)).to.be.revertedWithCustomError(
        partitionToken,
        "InvalidDocument",
      );
      await expect(issuerToken.setDocument(PROSPECTUS, "", HASH_A)).to.be.revertedWithCustomError(
        partitionToken,
        "InvalidDocument",
      );
      await expect(issuerToken.removeDocument(PROSPECTUS))
        .to.be.revertedWithCustomError(partitionToken, "DocumentNotFound")
        .withArgs(PROSPECTUS);
      await expect(
        partitionToken.connect(alice).setDocument(PROSPECTUS, "ipfs://x", HASH_A),
      ).to.be.revertedWithCustomError(partitionToken, "AccessControlUnauthorizedAccount");
      await expect(partitionToken.connect(alice).removeDocument(PROSPECTUS)).to.be.revertedWithCustomError(
        partitionToken,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("accounting", function () {
    it("keeps partition balances and supplies consistent across mixed operations", async function () {
      const { partitionToken, issuerOp, controller, alice, bob, carol, kyc, issue } =
        await networkHelpers.loadFixture(fixture);
      await kyc(carol, "carol");
      await issue(LOCKUP, bob.address, 20n);
      await partitionToken.connect(issuerOp).setConversion(LOCKUP, GENERAL);
      await partitionToken.connect(alice).transferByPartition(GENERAL, carol.address, 30n, "0x");
      await partitionToken.connect(bob).convertPartition(LOCKUP, 5n);
      await partitionToken.connect(controller).controllerTransferByPartition(LOCKUP, alice.address, carol.address, 10n, "0x", "0x");
      await partitionToken.connect(issuerOp).redeemByPartition(GENERAL, carol.address, 30n, "0x");
      await partitionToken.connect(controller).controllerRedeemByPartition(LOCKUP, bob.address, 15n, "0x", "0x");
      await partitionToken.connect(alice).transferByPartition(GENERAL, bob.address, 0n, "0x");

      let total = 0n;
      const supplyByPartition = new Map<string, bigint>([[GENERAL, 0n], [LOCKUP, 0n]]);
      for (const holder of [alice, bob, carol]) {
        let holderTotal = 0n;
        const listed = await partitionToken.partitionsOf(holder.address);
        for (const partition of [GENERAL, LOCKUP]) {
          const balance = await partitionToken.balanceOfByPartition(partition, holder.address);
          holderTotal += balance;
          supplyByPartition.set(partition, supplyByPartition.get(partition)! + balance);
          expect(listed.includes(partition), `${partition} listed for holder`).to.equal(balance > 0n);
        }
        expect(await partitionToken.balanceOf(holder.address)).to.equal(holderTotal);
        total += holderTotal;
      }
      expect(await partitionToken.totalSupply()).to.equal(total);
      for (const [partition, supply] of supplyByPartition) {
        expect(await partitionToken.totalSupplyByPartition(partition)).to.equal(supply);
      }
    });
  });
});
