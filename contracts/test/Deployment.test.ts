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
      token: { name: "Example Fund Unit", symbol: "EFU", adminTransferDelay: 3600 },
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

  it("uses an existing cash token when one is configured", async function () {
    const { config, deployer } = await networkHelpers.loadFixture(fixture);
    const existing = await ethers.deployContract("USDC");
    const deployment = await deployAll(connection, deployer, { ...config, cash: await existing.getAddress() });
    expect(deployment.contracts.cash).to.equal(await existing.getAddress());
  });
});
