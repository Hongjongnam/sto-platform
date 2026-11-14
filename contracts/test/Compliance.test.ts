import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { InvestorType, investorId, US } from "./helpers/identity.js";
import { deploySystem, MAX_HOLDERS, QUALIFIED_LIMIT, REASON, RETAIL_LIMIT } from "./helpers/system.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("ModularCompliance", function () {
  async function fixture() {
    return deploySystem(connection);
  }

  describe("module management", function () {
    it("lists the active modules", async function () {
      const { compliance, maxBalance, maxHolders } = await networkHelpers.loadFixture(fixture);
      expect(await compliance.modules()).to.deep.equal([await maxBalance.getAddress(), await maxHolders.getAddress()]);
    });

    it("adds and removes a module", async function () {
      const { compliance, admin, maxBalance, maxHolders } = await networkHelpers.loadFixture(fixture);
      const country = await ethers.deployContract("CountryAllowModule", [admin.address]);
      await expect(compliance.addModule(await country.getAddress()))
        .to.emit(compliance, "ModuleAdded")
        .withArgs(await country.getAddress(), admin.address);
      await expect(compliance.removeModule(await maxBalance.getAddress()))
        .to.emit(compliance, "ModuleRemoved")
        .withArgs(await maxBalance.getAddress(), admin.address);
      expect(await compliance.modules()).to.deep.equal([await country.getAddress(), await maxHolders.getAddress()]);
    });

    it("rejects duplicates, the zero address and unknown modules", async function () {
      const { compliance, maxBalance, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(compliance.addModule(await maxBalance.getAddress()))
        .to.be.revertedWithCustomError(compliance, "ModuleAlreadyAdded")
        .withArgs(await maxBalance.getAddress());
      await expect(compliance.addModule(ZeroAddress)).to.be.revertedWithCustomError(compliance, "ZeroAddress");
      await expect(compliance.removeModule(outsider.address))
        .to.be.revertedWithCustomError(compliance, "ModuleNotFound")
        .withArgs(outsider.address);
    });

    it("caps the number of modules at ten", async function () {
      const { compliance, admin } = await networkHelpers.loadFixture(fixture);
      for (let i = 0; i < 8; i++) {
        const module = await ethers.deployContract("CountryAllowModule", [admin.address]);
        await compliance.addModule(await module.getAddress());
      }
      const extra = await ethers.deployContract("CountryAllowModule", [admin.address]);
      await expect(compliance.addModule(await extra.getAddress())).to.be.revertedWithCustomError(
        compliance,
        "TooManyModules",
      );
    });

    it("only lets the owner change modules", async function () {
      const { compliance, maxBalance, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(
        compliance.connect(outsider).removeModule(await maxBalance.getAddress()),
      ).to.be.revertedWithCustomError(compliance, "OwnableUnauthorizedAccount");
      await expect(
        compliance.connect(outsider).addModule(await maxBalance.getAddress()),
      ).to.be.revertedWithCustomError(compliance, "OwnableUnauthorizedAccount");
    });

    it("transfers ownership in two steps", async function () {
      const { compliance, admin, outsider } = await networkHelpers.loadFixture(fixture);
      await compliance.transferOwnership(outsider.address);
      expect(await compliance.owner()).to.equal(admin.address);
      await compliance.connect(outsider).acceptOwnership();
      expect(await compliance.owner()).to.equal(outsider.address);
    });

    it("accepts everything when no module is active", async function () {
      const { compliance, maxBalance, maxHolders, token, alice, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await compliance.removeModule(await maxBalance.getAddress());
      await compliance.removeModule(await maxHolders.getAddress());
      await kyc(alice, "alice");
      await mint(alice, RETAIL_LIMIT * 5n);
      expect(await token.balanceOf(alice.address)).to.equal(RETAIL_LIMIT * 5n);
    });

    it("reports which module rejects a movement", async function () {
      const { compliance, maxBalance, token, alice, kyc } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      const tokenAddress = await token.getAddress();
      expect(await compliance.firstFailingModule(tokenAddress, ZeroAddress, alice.address, RETAIL_LIMIT)).to.equal(
        ZeroAddress,
      );
      expect(await compliance.firstFailingModule(tokenAddress, ZeroAddress, alice.address, RETAIL_LIMIT + 1n)).to.equal(
        await maxBalance.getAddress(),
      );
      expect(await compliance.canTransfer(tokenAddress, ZeroAddress, alice.address, RETAIL_LIMIT + 1n)).to.equal(false);
    });
  });

  describe("MaxBalanceModule", function () {
    it("allows holding exactly the cap and rejects one more", async function () {
      const { token, alice, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await mint(alice, RETAIL_LIMIT);
      await expect(mint(alice, 1n))
        .to.be.revertedWithCustomError(token, "ComplianceRejected")
        .withArgs(ZeroAddress, alice.address, 1n);
    });

    it("applies the cap of the receiver's investor type", async function () {
      const { token, alice, bob, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice", { investorType: InvestorType.Qualified });
      await kyc(bob, "bob");
      await mint(alice, QUALIFIED_LIMIT);
      await expect(token.connect(alice).transfer(bob.address, RETAIL_LIMIT + 1n)).to.be.revertedWithCustomError(
        token,
        "ComplianceRejected",
      );
      await token.connect(alice).transfer(bob.address, RETAIL_LIMIT);
    });

    it("counts all wallets of one investor against a single cap", async function () {
      const { token, alice, aliceSecond, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await kyc(aliceSecond, "alice");
      await mint(alice, RETAIL_LIMIT - 100n);
      await expect(mint(aliceSecond, 101n)).to.be.revertedWithCustomError(token, "ComplianceRejected");
      await mint(aliceSecond, 100n);
      expect(await token.investorBalanceOf(investorId("alice"))).to.equal(RETAIL_LIMIT);
    });

    it("lets an investor at the cap move tokens between their own wallets", async function () {
      const { token, alice, aliceSecond, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await kyc(alice, "alice");
      await kyc(aliceSecond, "alice");
      await mint(alice, RETAIL_LIMIT);
      await token.connect(alice).transfer(aliceSecond.address, RETAIL_LIMIT);
      expect(await token.balanceOf(aliceSecond.address)).to.equal(RETAIL_LIMIT);
    });

    it("blocks an investor type that has no cap configured", async function () {
      const { token, maxBalance, alice, kyc, mint } = await networkHelpers.loadFixture(fixture);
      await maxBalance.setMaxBalance(InvestorType.Retail, 0);
      await kyc(alice, "alice");
      await expect(mint(alice, 1n)).to.be.revertedWithCustomError(token, "ComplianceRejected");
    });

    it("only lets the owner change caps", async function () {
      const { maxBalance, admin, outsider } = await networkHelpers.loadFixture(fixture);
      await expect(maxBalance.connect(outsider).setMaxBalance(0, 1)).to.be.revertedWithCustomError(
        maxBalance,
        "OwnableUnauthorizedAccount",
      );
      await expect(maxBalance.setMaxBalance(InvestorType.Retail, 5n))
        .to.emit(maxBalance, "MaxBalanceSet")
        .withArgs(InvestorType.Retail, 5n, admin.address);
      expect(await maxBalance.maxBalanceOf(InvestorType.Retail)).to.equal(5n);
      expect(await maxBalance.name()).to.equal("MaxBalanceModule");
    });
  });

  describe("MaxHoldersModule", function () {
    async function fullFixture() {
      const system = await deploySystem(connection);
      const { alice, bob, carol, dave, erin, kyc, mint } = system;
      const holders = [alice, bob, carol, dave, erin];
      for (const [i, holder] of holders.entries()) {
        await kyc(holder, `holder-${i}`);
        await mint(holder, 100n);
      }
      await kyc(system.frank, "frank");
      return { ...system, holders };
    }

    it("rejects a new investor once the cap is reached", async function () {
      const { token, frank, alice, mint } = await networkHelpers.loadFixture(fullFixture);
      expect(await token.holderCount()).to.equal(MAX_HOLDERS);
      await expect(mint(frank, 1n)).to.be.revertedWithCustomError(token, "ComplianceRejected");
      await expect(token.connect(alice).transfer(frank.address, 1n)).to.be.revertedWithCustomError(
        token,
        "ComplianceRejected",
      );
    });

    it("still lets existing holders receive more", async function () {
      const { token, alice, bob } = await networkHelpers.loadFixture(fullFixture);
      await token.connect(alice).transfer(bob.address, 50n);
      expect(await token.balanceOf(bob.address)).to.equal(150n);
    });

    it("lets a holder hand their entire position to a new investor", async function () {
      const { token, alice, frank } = await networkHelpers.loadFixture(fullFixture);
      await token.connect(alice).transfer(frank.address, 100n);
      expect(await token.holderCount()).to.equal(MAX_HOLDERS);
      expect(await token.balanceOf(frank.address)).to.equal(100n);
    });

    it("frees a slot when a holder is fully redeemed", async function () {
      const { token, issuerOp, alice, frank, mint } = await networkHelpers.loadFixture(fullFixture);
      await token.connect(issuerOp).burn(alice.address, 100n, REASON);
      expect(await token.holderCount()).to.equal(MAX_HOLDERS - 1n);
      await mint(frank, 1n);
      expect(await token.holderCount()).to.equal(MAX_HOLDERS);
    });

    it("does not count a second wallet of an existing holder", async function () {
      const { token, alice, aliceSecond, kyc } = await networkHelpers.loadFixture(fullFixture);
      await kyc(aliceSecond, "holder-0");
      await token.connect(alice).transfer(aliceSecond.address, 10n);
      expect(await token.holderCount()).to.equal(MAX_HOLDERS);
    });

    it("only lets the owner change the cap", async function () {
      const { maxHolders, admin, outsider } = await networkHelpers.loadFixture(fullFixture);
      await expect(maxHolders.connect(outsider).setMaxHolders(1)).to.be.revertedWithCustomError(
        maxHolders,
        "OwnableUnauthorizedAccount",
      );
      await expect(maxHolders.setMaxHolders(6n)).to.emit(maxHolders, "MaxHoldersSet").withArgs(6n, admin.address);
      expect(await maxHolders.maxHolders()).to.equal(6n);
      expect(await maxHolders.name()).to.equal("MaxHoldersModule");
    });

    it("enforces the cap when added after tokens are already held", async function () {
      const { token, compliance, maxHolders, admin, frank, mint } = await networkHelpers.loadFixture(fullFixture);
      await compliance.removeModule(await maxHolders.getAddress());
      const late = await ethers.deployContract("MaxHoldersModule", [admin.address, MAX_HOLDERS]);
      await compliance.addModule(await late.getAddress());
      await expect(mint(frank, 1n)).to.be.revertedWithCustomError(token, "ComplianceRejected");
    });
  });

  describe("CountryAllowModule", function () {
    it("only lets investors from allowed countries receive tokens", async function () {
      const { token, compliance, admin, alice, bob, kyc, mint } = await networkHelpers.loadFixture(fixture);
      const country = await ethers.deployContract("CountryAllowModule", [admin.address]);
      await expect(country.setCountryAllowed(410, true)).to.emit(country, "CountryAllowed").withArgs(410, true, admin.address);
      await compliance.addModule(await country.getAddress());
      await kyc(alice, "alice");
      await kyc(bob, "bob", { country: US });

      await mint(alice, 10n);
      await expect(mint(bob, 10n)).to.be.revertedWithCustomError(token, "ComplianceRejected");
      await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        token,
        "ComplianceRejected",
      );

      await country.setCountryAllowed(US, true);
      await mint(bob, 10n);
      expect(await country.isCountryAllowed(US)).to.equal(true);
      expect(await country.name()).to.equal("CountryAllowModule");
    });

    it("only lets the owner change the list", async function () {
      const { admin, outsider } = await networkHelpers.loadFixture(fixture);
      const country = await ethers.deployContract("CountryAllowModule", [admin.address]);
      await expect(country.connect(outsider).setCountryAllowed(410, true)).to.be.revertedWithCustomError(
        country,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
