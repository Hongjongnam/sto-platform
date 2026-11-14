import { expect } from "chai";
import { network } from "hardhat";
import { acceptHandover, attach, deployAll, type DeployConfig, ROLE, verifyHandover } from "../scripts/lib/deploy.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("deployment", function () {
  async function fixture() {
    const [deployer, admin, issuer, enforcer, pauser, registrar, upgrader, settlement, kycIssuer, treasury] =
      await ethers.getSigners();
    const config: DeployConfig = {
      token: { name: "Example Fund Unit", symbol: "EFU", adminTransferDelay: 3600, upgradeDelay: 2 * 24 * 60 * 60 },
      roles: {
        admin: admin.address,
        issuer: issuer.address,
        enforcer: enforcer.address,
        pauser: pauser.address,
        registrar: registrar.address,
        upgrader: upgrader.address,
        settlement: settlement.address,
        kycIssuer: kycIssuer.address,
        treasury: treasury.address,
      },
      compliance: { maxBalance: { "0": "1000", "1": "10000", "2": "100000" }, maxHolders: "100", allowedCountries: [410] },
      cash: null,
    };
    const deployment = await deployAll(connection, deployer, config);
    return { deployment, config, deployer, admin };
  }

  it("leaves the two-step transfers pending until the admin accepts", async function () {
    const { deployment, deployer, admin } = await networkHelpers.loadFixture(fixture);
    const { compliance, token } = await attach(connection, deployment);

    expect(await compliance.owner()).to.equal(deployer.address);
    expect(await compliance.pendingOwner()).to.equal(admin.address);
    expect(await token.defaultAdmin()).to.equal(deployer.address);
    expect((await token.pendingDefaultAdmin())[0]).to.equal(admin.address);

    const problems = await verifyHandover(connection, deployment);
    expect(problems).to.include("compliance: not owned by admin");
    expect(problems).to.include("securityToken: default admin is not admin");
  });

  it("gives the admin full control and leaves the deployer with nothing after acceptance", async function () {
    const { deployment, config, deployer, admin } = await networkHelpers.loadFixture(fixture);
    await acceptHandover(connection, deployment, admin, config.token.adminTransferDelay);

    expect(await verifyHandover(connection, deployment)).to.deep.equal([]);

    const { token, registry, compliance } = await attach(connection, deployment);
    expect(await token.hasRole(ROLE.ADMIN, deployer.address)).to.equal(false);
    expect(await registry.hasRole(ROLE.ADMIN, deployer.address)).to.equal(false);
    expect(await compliance.owner()).to.equal(admin.address);
    expect((await token.pendingDefaultAdminDelay())[0]).to.equal(BigInt(config.token.adminTransferDelay));
  });

  it("wires the contracts to each other", async function () {
    const { deployment } = await networkHelpers.loadFixture(fixture);
    const { token, compliance, dvp } = await attach(connection, deployment);
    const c = deployment.contracts;
    expect(await token.identityRegistry()).to.equal(c.identityRegistry);
    expect(await token.compliance()).to.equal(c.compliance);
    expect(await compliance.modules()).to.deep.equal([c.maxBalanceModule, c.maxHoldersModule, c.countryAllowModule]);
    expect(await dvp.isSecurityAllowed(c.securityToken)).to.equal(true);
    expect(await dvp.isCashAllowed(c.cash)).to.equal(true);
    expect(c.securityTokenImplementation).to.not.equal(c.securityToken);
    expect(deployment.startBlock).to.be.greaterThan(0);
  });

  describe("upgrades", function () {
    const SALT = ethers.ZeroHash;

    async function upgradeFixture() {
      const base = await fixture();
      await acceptHandover(connection, base.deployment, base.admin, base.config.token.adminTransferDelay);
      const upgrader = await ethers.getSigner(base.config.roles.upgrader);
      const { token, timelock } = await attach(connection, base.deployment, upgrader);
      const implementation = await ethers.deployContract("SecurityTokenV2");
      // The call the timelock will make: upgrade the proxy and run the new version's initializer.
      const data = token.interface.encodeFunctionData("upgradeToAndCall", [
        await implementation.getAddress(),
        implementation.interface.encodeFunctionData("initializeV2"),
      ]);
      const target = await token.getAddress();
      return { ...base, upgrader, token, timelock, target, data };
    }

    it("cannot be done by the upgrader account directly", async function () {
      const { token, upgrader } = await networkHelpers.loadFixture(upgradeFixture);
      const implementation = await ethers.deployContract("SecurityTokenV2");
      await expect(token.connect(upgrader).upgradeToAndCall(await implementation.getAddress(), "0x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(upgrader.address, ROLE.UPGRADER);
    });

    it("must wait for the delay after being scheduled", async function () {
      const { config, timelock, target, data } = await networkHelpers.loadFixture(upgradeFixture);
      const delay = config.token.upgradeDelay;
      await expect(timelock.schedule(target, 0, data, SALT, SALT, delay - 1)).to.be.revertedWithCustomError(
        timelock,
        "TimelockInsufficientDelay",
      );

      await timelock.schedule(target, 0, data, SALT, SALT, delay);
      await expect(timelock.execute(target, 0, data, SALT, SALT)).to.be.revertedWithCustomError(
        timelock,
        "TimelockUnexpectedOperationState",
      );
    });

    it("takes effect once the delay has passed and keeps the token's state", async function () {
      const { deployment, config, timelock, target, data } = await networkHelpers.loadFixture(upgradeFixture);
      await timelock.schedule(target, 0, data, SALT, SALT, config.token.upgradeDelay);
      await networkHelpers.time.increase(config.token.upgradeDelay);
      await timelock.execute(target, 0, data, SALT, SALT);

      const upgraded = await ethers.getContractAt("SecurityTokenV2", target);
      expect(await upgraded.version()).to.equal("2");
      expect(await upgraded.identityRegistry()).to.equal(deployment.contracts.identityRegistry);
      expect(await upgraded.name()).to.equal("Example Fund Unit");
    });

    it("can be cancelled while it is waiting", async function () {
      const { config, timelock, target, data } = await networkHelpers.loadFixture(upgradeFixture);
      await timelock.schedule(target, 0, data, SALT, SALT, config.token.upgradeDelay);
      const id = await timelock.hashOperation(target, 0, data, SALT, SALT);
      await timelock.cancel(id);
      await networkHelpers.time.increase(config.token.upgradeDelay);
      await expect(timelock.execute(target, 0, data, SALT, SALT)).to.be.revertedWithCustomError(
        timelock,
        "TimelockUnexpectedOperationState",
      );
    });

    it("can only be scheduled by the proposer", async function () {
      const { config, admin, timelock, target, data } = await networkHelpers.loadFixture(upgradeFixture);
      await expect(
        timelock.connect(admin).schedule(target, 0, data, SALT, SALT, config.token.upgradeDelay),
      ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
  });

  it("uses an existing cash token when one is configured", async function () {
    const { config, deployer } = await networkHelpers.loadFixture(fixture);
    const existing = await ethers.deployContract("USDC");
    const deployment = await deployAll(connection, deployer, { ...config, cash: await existing.getAddress() });
    expect(deployment.contracts.cash).to.equal(await existing.getAddress());
  });
});
