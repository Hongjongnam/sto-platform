import { expect } from "chai";
import { encodeBytes32String, ZeroAddress, ZeroHash } from "ethers";
import { network } from "hardhat";
import {
  type Claim,
  InvestorType,
  investorId,
  KR,
  ONE_YEAR,
  REGISTRAR_ROLE,
  signClaim,
  US,
} from "./helpers/identity.js";

const { ethers, networkHelpers } = await network.create();

describe("IdentityRegistry", function () {
  async function deployFixture() {
    const [admin, registrar, issuer, otherIssuer, alice, aliceSecond, bob, outsider] = await ethers.getSigners();
    const registry = await ethers.deployContract("IdentityRegistry", [admin.address]);
    await registry.grantRole(REGISTRAR_ROLE, registrar.address);
    await registry.setTrustedIssuer(issuer.address, true);
    const now = BigInt(await networkHelpers.time.latest());

    function claimFor(wallet: string, label: string, overrides: Partial<Claim> = {}): Claim {
      return {
        wallet,
        investorId: investorId(label),
        country: KR,
        investorType: InvestorType.Retail,
        expiry: now + BigInt(ONE_YEAR),
        ...overrides,
      };
    }

    async function register(claim: Claim, signer = issuer) {
      const signature = await signClaim(signer, registry, claim, await registry.nonces(claim.wallet));
      return registry.connect(registrar).registerIdentity(claim, signature);
    }

    return { registry, admin, registrar, issuer, otherIssuer, alice, aliceSecond, bob, outsider, now, claimFor, register };
  }

  describe("deployment", function () {
    it("grants the admin role to the given admin", async function () {
      const { registry, admin } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("rejects a zero admin", async function () {
      const factory = await ethers.getContractFactory("IdentityRegistry");
      await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("trusted issuers", function () {
    it("lets the admin add and remove an issuer", async function () {
      const { registry, admin, otherIssuer } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.setTrustedIssuer(otherIssuer.address, true))
        .to.emit(registry, "TrustedIssuerSet")
        .withArgs(otherIssuer.address, true, admin.address);
      expect(await registry.isTrustedIssuer(otherIssuer.address)).to.equal(true);
      await registry.setTrustedIssuer(otherIssuer.address, false);
      expect(await registry.isTrustedIssuer(otherIssuer.address)).to.equal(false);
    });

    it("rejects a non-admin caller", async function () {
      const { registry, registrar, otherIssuer } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        registry.connect(registrar).setTrustedIssuer(otherIssuer.address, true),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects the zero address", async function () {
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.setTrustedIssuer(ZeroAddress, true)).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  describe("registration", function () {
    it("registers a wallet from a trusted issuer's claim", async function () {
      const { registry, registrar, issuer, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice", { investorType: InvestorType.Qualified });

      await expect(register(claim))
        .to.emit(registry, "IdentityRegistered")
        .withArgs(
          alice.address,
          claim.investorId,
          KR,
          InvestorType.Qualified,
          claim.expiry,
          issuer.address,
          registrar.address,
        );

      expect(await registry.isVerified(alice.address)).to.equal(true);
      expect(await registry.investorOf(alice.address)).to.equal(claim.investorId);
      expect(await registry.investorTypeOf(alice.address)).to.equal(BigInt(InvestorType.Qualified));
      expect(await registry.countryOf(alice.address)).to.equal(BigInt(KR));
      expect(await registry.nonces(alice.address)).to.equal(1n);

      const identity = await registry.identityOf(alice.address);
      expect(identity.expiry).to.equal(claim.expiry);
      expect(identity.revoked).to.equal(false);
    });

    it("reports an unregistered wallet as not verified with no investor", async function () {
      const { registry, outsider } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isVerified(outsider.address)).to.equal(false);
      expect(await registry.investorOf(outsider.address)).to.equal(ZeroHash);
    });

    it("links several wallets to the same investor", async function () {
      const { registry, alice, aliceSecond, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      await register(claimFor(aliceSecond.address, "alice"));
      expect(await registry.investorOf(alice.address)).to.equal(await registry.investorOf(aliceSecond.address));
      expect(await registry.isVerified(aliceSecond.address)).to.equal(true);
    });

    it("rejects a claim signed by an untrusted issuer", async function () {
      const { registry, otherIssuer, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await expect(register(claimFor(alice.address, "alice"), otherIssuer))
        .to.be.revertedWithCustomError(registry, "UntrustedIssuer")
        .withArgs(otherIssuer.address);
    });

    it("rejects a claim whose fields were changed after signing", async function () {
      const { registry, registrar, issuer, alice, claimFor } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      const signature = await signClaim(issuer, registry, claim, 0n);
      const tampered = { ...claim, investorType: InvestorType.Professional };
      await expect(
        registry.connect(registrar).registerIdentity(tampered, signature),
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });

    it("rejects reuse of a signature", async function () {
      const { registry, registrar, issuer, alice, claimFor } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      const signature = await signClaim(issuer, registry, claim, 0n);
      await registry.connect(registrar).registerIdentity(claim, signature);
      await expect(
        registry.connect(registrar).registerIdentity(claim, signature),
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });

    it("rejects a signature made for another registry", async function () {
      const { registry, admin, registrar, issuer, alice, claimFor } = await networkHelpers.loadFixture(deployFixture);
      const otherRegistry = await ethers.deployContract("IdentityRegistry", [admin.address]);
      const claim = claimFor(alice.address, "alice");
      const signature = await signClaim(issuer, otherRegistry, claim, 0n);
      await expect(
        registry.connect(registrar).registerIdentity(claim, signature),
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });

    it("rejects a signature made for another chain", async function () {
      const { registry, registrar, issuer, alice, claimFor } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      const signature = await signClaim(issuer, registry, claim, 0n, 1n);
      await expect(
        registry.connect(registrar).registerIdentity(claim, signature),
      ).to.be.revertedWithCustomError(registry, "UntrustedIssuer");
    });

    it("rejects a claim that has already expired", async function () {
      const { registry, alice, now, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice", { expiry: now });
      await expect(register(claim)).to.be.revertedWithCustomError(registry, "ClaimExpired").withArgs(now);
    });

    it("rejects a caller without the registrar role", async function () {
      const { registry, issuer, alice, outsider, claimFor } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      const signature = await signClaim(issuer, registry, claim, 0n);
      await expect(
        registry.connect(outsider).registerIdentity(claim, signature),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects a zero wallet, a zero investor id and an unknown investor type", async function () {
      const { registry, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await expect(register(claimFor(ZeroAddress, "alice"))).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        register(claimFor(alice.address, "alice", { investorId: ZeroHash })),
      ).to.be.revertedWithCustomError(registry, "ZeroInvestorId");
      await expect(register(claimFor(alice.address, "alice", { investorType: 3 })))
        .to.be.revertedWithCustomError(registry, "InvalidInvestorType")
        .withArgs(3);
    });
  });

  describe("renewal", function () {
    it("updates expiry, country and type for the same investor", async function () {
      const { registry, alice, now, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      const renewed = claimFor(alice.address, "alice", {
        country: US,
        investorType: InvestorType.Professional,
        expiry: now + BigInt(2 * ONE_YEAR),
      });
      await register(renewed);

      const identity = await registry.identityOf(alice.address);
      expect(identity.expiry).to.equal(renewed.expiry);
      expect(identity.country).to.equal(BigInt(US));
      expect(identity.investorType).to.equal(BigInt(InvestorType.Professional));
      expect(await registry.nonces(alice.address)).to.equal(2n);
    });

    it("rejects linking a registered wallet to a different investor", async function () {
      const { registry, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      await expect(register(claimFor(alice.address, "mallory")))
        .to.be.revertedWithCustomError(registry, "InvestorMismatch")
        .withArgs(alice.address, investorId("alice"), investorId("mallory"));
    });
  });

  describe("expiry", function () {
    it("stops verifying a wallet once its claim expires but keeps the investor link", async function () {
      const { registry, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      await register(claim);

      await networkHelpers.time.increaseTo(claim.expiry - 1n);
      expect(await registry.isVerified(alice.address)).to.equal(true);

      await networkHelpers.time.increaseTo(claim.expiry);
      expect(await registry.isVerified(alice.address)).to.equal(false);
      expect(await registry.investorOf(alice.address)).to.equal(claim.investorId);
    });
  });

  describe("revocation", function () {
    const REASON = encodeBytes32String("KYC_WITHDRAWN");

    it("revokes an identity and keeps the investor link", async function () {
      const { registry, registrar, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      const claim = claimFor(alice.address, "alice");
      await register(claim);

      await expect(registry.connect(registrar).revokeIdentity(alice.address, REASON))
        .to.emit(registry, "IdentityRevoked")
        .withArgs(alice.address, claim.investorId, registrar.address, REASON);

      expect(await registry.isVerified(alice.address)).to.equal(false);
      expect(await registry.investorOf(alice.address)).to.equal(claim.investorId);
    });

    it("restores verification when the same investor registers again", async function () {
      const { registry, registrar, alice, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await register(claimFor(alice.address, "alice"));
      expect(await registry.isVerified(alice.address)).to.equal(true);
    });

    it("rejects revoking an unknown or already revoked wallet", async function () {
      const { registry, registrar, alice, outsider, claimFor, register } =
        await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(registrar).revokeIdentity(outsider.address, REASON))
        .to.be.revertedWithCustomError(registry, "IdentityNotFound")
        .withArgs(outsider.address);

      await register(claimFor(alice.address, "alice"));
      await registry.connect(registrar).revokeIdentity(alice.address, REASON);
      await expect(registry.connect(registrar).revokeIdentity(alice.address, REASON))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked")
        .withArgs(alice.address);
    });

    it("rejects a caller without the registrar role", async function () {
      const { registry, alice, outsider, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      await expect(
        registry.connect(outsider).revokeIdentity(alice.address, REASON),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("issuer removal", function () {
    it("keeps existing identities valid and rejects new claims from the removed issuer", async function () {
      const { registry, issuer, alice, bob, claimFor, register } = await networkHelpers.loadFixture(deployFixture);
      await register(claimFor(alice.address, "alice"));
      await registry.setTrustedIssuer(issuer.address, false);

      expect(await registry.isVerified(alice.address)).to.equal(true);
      await expect(register(claimFor(bob.address, "bob")))
        .to.be.revertedWithCustomError(registry, "UntrustedIssuer")
        .withArgs(issuer.address);
    });
  });
});
