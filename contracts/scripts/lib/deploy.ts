import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { id, ZeroHash } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

export interface DeployConfig {
  token: {
    name: string;
    symbol: string;
    /** Seconds an admin transfer must wait before it can be accepted. */
    adminTransferDelay: number;
    /** Seconds an upgrade must wait between being scheduled and being executed. */
    upgradeDelay: number;
  };
  roles: {
    admin: string;
    issuer: string;
    enforcer: string;
    pauser: string;
    registrar: string;
    upgrader: string;
    settlement: string;
    kycIssuer: string;
    treasury: string;
  };
  compliance: {
    /** Cap per investor type, keyed by the numeric type. */
    maxBalance: Record<string, string>;
    maxHolders: string;
    /** ISO 3166-1 numeric codes. */
    allowedCountries: number[];
  };
  /** Address of an existing cash token, or null to deploy the test USDC. */
  cash: string | null;
}

export interface Deployment {
  chainId: string;
  deployer: string;
  /** Block of the first deployment transaction; indexers start here. */
  startBlock: number;
  roles: DeployConfig["roles"];
  contracts: {
    identityRegistry: string;
    compliance: string;
    maxBalanceModule: string;
    maxHoldersModule: string;
    countryAllowModule: string;
    securityToken: string;
    securityTokenImplementation: string;
    upgradeTimelock: string;
    cash: string;
    dvpSettlement: string;
    dividendDistributor: string;
    redemptionManager: string;
  };
}

export const ROLE = {
  ADMIN: ZeroHash,
  ISSUER: id("ISSUER_ROLE"),
  ENFORCER: id("ENFORCER_ROLE"),
  PAUSER: id("PAUSER_ROLE"),
  REGISTRAR: id("REGISTRAR_ROLE"),
  UPGRADER: id("UPGRADER_ROLE"),
  SETTLEMENT: id("SETTLEMENT_ROLE"),
} as const;

/**
 * Deploys and wires every contract from `deployer`, then starts handing control to the
 * configured admin. Contracts with single-step admin roles are handed over completely here;
 * ownership of the compliance contracts and the token's default admin use two-step transfers
 * and stay pending until the admin runs `acceptHandover`.
 */
export async function deployAll(
  connection: NetworkConnection,
  deployer: HardhatEthersSigner,
  config: DeployConfig,
): Promise<Deployment> {
  const { ethers } = connection;
  const upgradesApi = await upgrades(hre, connection);
  const { roles } = config;
  const wait = async (tx: Promise<{ wait(): Promise<unknown> }>) => (await tx).wait();
  const deploy = async (name: string, args: unknown[] = []) => {
    const contract = await ethers.deployContract(name, args, deployer);
    await contract.waitForDeployment();
    return contract;
  };

  const startBlock = (await ethers.provider.getBlockNumber()) + 1;

  // Identity
  const registry = await ethers.getContractAt("IdentityRegistry", await (await deploy("IdentityRegistry", [deployer.address])).getAddress(), deployer);
  await wait(registry.grantRole(ROLE.REGISTRAR, roles.registrar));
  await wait(registry.setTrustedIssuer(roles.kycIssuer, true));

  // Compliance
  const compliance = await ethers.getContractAt("ModularCompliance", await (await deploy("ModularCompliance", [deployer.address])).getAddress(), deployer);
  const maxBalance = await ethers.getContractAt("MaxBalanceModule", await (await deploy("MaxBalanceModule", [deployer.address])).getAddress(), deployer);
  for (const [investorType, cap] of Object.entries(config.compliance.maxBalance)) {
    await wait(maxBalance.setMaxBalance(Number(investorType), BigInt(cap)));
  }
  const maxHolders = await ethers.getContractAt(
    "MaxHoldersModule",
    await (await deploy("MaxHoldersModule", [deployer.address, BigInt(config.compliance.maxHolders)])).getAddress(),
    deployer,
  );
  const country = await ethers.getContractAt("CountryAllowModule", await (await deploy("CountryAllowModule", [deployer.address])).getAddress(), deployer);
  for (const code of config.compliance.allowedCountries) await wait(country.setCountryAllowed(code, true));
  for (const module of [maxBalance, maxHolders, country]) await wait(compliance.addModule(await module.getAddress()));

  // Cash
  const cashAddress = config.cash ?? (await (await deploy("USDC")).getAddress());

  // Token
  const tokenFactory = await ethers.getContractFactory("SecurityToken", deployer);
  const proxy = await upgradesApi.deployProxy(
    tokenFactory,
    [config.token.name, config.token.symbol, deployer.address, 0, await registry.getAddress(), await compliance.getAddress()],
    { kind: "uups" },
  );
  await proxy.waitForDeployment();
  const tokenAddress = await proxy.getAddress();
  const token = await ethers.getContractAt("SecurityToken", tokenAddress, deployer);
  const implementation = await upgradesApi.erc1967.getImplementationAddress(tokenAddress);

  // Settlement and corporate actions
  const dvp = await ethers.getContractAt("DvPSettlement", await (await deploy("DvPSettlement", [deployer.address])).getAddress(), deployer);
  await wait(dvp.grantRole(ROLE.SETTLEMENT, roles.settlement));
  await wait(dvp.setSecurityAllowed(tokenAddress, true));
  await wait(dvp.setCashAllowed(cashAddress, true));

  const dividend = await ethers.getContractAt("DividendDistributor", await (await deploy("DividendDistributor", [deployer.address])).getAddress(), deployer);
  await wait(dividend.grantRole(ROLE.ISSUER, roles.treasury));
  const redemption = await ethers.getContractAt("RedemptionManager", await (await deploy("RedemptionManager", [deployer.address])).getAddress(), deployer);
  await wait(redemption.grantRole(ROLE.ISSUER, roles.treasury));

  // Token roles. The redemption manager burns on behalf of holders, so it is an issuer too.
  await wait(token.grantRole(ROLE.ISSUER, roles.issuer));
  await wait(token.grantRole(ROLE.ISSUER, await redemption.getAddress()));
  await wait(token.grantRole(ROLE.ENFORCER, roles.enforcer));
  await wait(token.grantRole(ROLE.PAUSER, roles.pauser));
  await wait(token.grantRole(ROLE.REGISTRAR, roles.registrar));
  // Upgrades go through a timelock: the upgrader account schedules and executes, but only the
  // timelock itself holds the token's upgrader role.
  const timelock = await deploy("UpgradeTimelock", [config.token.upgradeDelay, [roles.upgrader], [roles.upgrader]]);
  await wait(token.grantRole(ROLE.UPGRADER, await timelock.getAddress()));

  // Handover
  for (const contract of [registry, dvp, dividend, redemption]) {
    await wait(contract.grantRole(ROLE.ADMIN, roles.admin));
    await wait(contract.renounceRole(ROLE.ADMIN, deployer.address));
  }
  for (const ownable of [compliance, maxBalance, maxHolders, country]) {
    await wait(ownable.transferOwnership(roles.admin));
  }
  await wait(token.beginDefaultAdminTransfer(roles.admin));

  const { chainId } = await ethers.provider.getNetwork();
  return {
    chainId: chainId.toString(),
    deployer: deployer.address,
    startBlock,
    roles,
    contracts: {
      identityRegistry: await registry.getAddress(),
      compliance: await compliance.getAddress(),
      maxBalanceModule: await maxBalance.getAddress(),
      maxHoldersModule: await maxHolders.getAddress(),
      countryAllowModule: await country.getAddress(),
      securityToken: tokenAddress,
      securityTokenImplementation: implementation,
      upgradeTimelock: await timelock.getAddress(),
      cash: cashAddress,
      dvpSettlement: await dvp.getAddress(),
      dividendDistributor: await dividend.getAddress(),
      redemptionManager: await redemption.getAddress(),
    },
  };
}

/** Typed handles to every deployed contract, connected to `signer`. */
export async function attach(connection: NetworkConnection, deployment: Deployment, signer?: HardhatEthersSigner) {
  const { ethers } = connection;
  const c = deployment.contracts;
  return {
    registry: await ethers.getContractAt("IdentityRegistry", c.identityRegistry, signer),
    compliance: await ethers.getContractAt("ModularCompliance", c.compliance, signer),
    maxBalance: await ethers.getContractAt("MaxBalanceModule", c.maxBalanceModule, signer),
    maxHolders: await ethers.getContractAt("MaxHoldersModule", c.maxHoldersModule, signer),
    country: await ethers.getContractAt("CountryAllowModule", c.countryAllowModule, signer),
    token: await ethers.getContractAt("SecurityToken", c.securityToken, signer),
    timelock: await ethers.getContractAt("UpgradeTimelock", c.upgradeTimelock, signer),
    cash: await ethers.getContractAt("USDC", c.cash, signer),
    dvp: await ethers.getContractAt("DvPSettlement", c.dvpSettlement, signer),
    dividend: await ethers.getContractAt("DividendDistributor", c.dividendDistributor, signer),
    redemption: await ethers.getContractAt("RedemptionManager", c.redemptionManager, signer),
  };
}

/**
 * Run by the admin: accepts the pending two-step transfers, then applies the configured
 * delay for future admin transfers.
 */
export async function acceptHandover(
  connection: NetworkConnection,
  deployment: Deployment,
  admin: HardhatEthersSigner,
  adminTransferDelay: number,
): Promise<void> {
  const { compliance, maxBalance, maxHolders, country, token } = await attach(connection, deployment, admin);
  for (const ownable of [compliance, maxBalance, maxHolders, country]) {
    await (await ownable.acceptOwnership()).wait();
  }
  await (await token.acceptDefaultAdminTransfer()).wait();
  if (adminTransferDelay > 0) await (await token.changeDefaultAdminDelay(adminTransferDelay)).wait();
}

/** Returns a list of problems; empty when the deployer holds nothing and every role is in place. */
export async function verifyHandover(connection: NetworkConnection, deployment: Deployment): Promise<string[]> {
  const { registry, compliance, maxBalance, maxHolders, country, token, dvp, dividend, redemption } = await attach(
    connection,
    deployment,
  );
  const { roles, deployer } = deployment;
  const problems: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) problems.push(message);
  };

  const accessControlled = { identityRegistry: registry, dvpSettlement: dvp, dividendDistributor: dividend, redemptionManager: redemption };
  for (const [name, contract] of Object.entries(accessControlled)) {
    expect(await contract.hasRole(ROLE.ADMIN, roles.admin), `${name}: admin role not held by admin`);
    expect(!(await contract.hasRole(ROLE.ADMIN, deployer)), `${name}: deployer still holds the admin role`);
  }
  const owned = { compliance, maxBalanceModule: maxBalance, maxHoldersModule: maxHolders, countryAllowModule: country };
  for (const [name, contract] of Object.entries(owned)) {
    expect((await contract.owner()) === roles.admin, `${name}: not owned by admin`);
  }

  expect((await token.defaultAdmin()) === roles.admin, "securityToken: default admin is not admin");
  for (const role of [ROLE.ADMIN, ROLE.ISSUER, ROLE.ENFORCER, ROLE.PAUSER, ROLE.REGISTRAR, ROLE.UPGRADER]) {
    expect(!(await token.hasRole(role, deployer)), `securityToken: deployer still holds role ${role}`);
  }
  expect(await token.hasRole(ROLE.ISSUER, roles.issuer), "securityToken: issuer role missing");
  expect(await token.hasRole(ROLE.ISSUER, deployment.contracts.redemptionManager), "securityToken: redemption manager cannot burn");
  expect(await token.hasRole(ROLE.ENFORCER, roles.enforcer), "securityToken: enforcer role missing");
  expect(await token.hasRole(ROLE.PAUSER, roles.pauser), "securityToken: pauser role missing");
  expect(await token.hasRole(ROLE.REGISTRAR, roles.registrar), "securityToken: registrar role missing");
  expect(await token.hasRole(ROLE.UPGRADER, deployment.contracts.upgradeTimelock), "securityToken: the timelock cannot upgrade");
  expect(!(await token.hasRole(ROLE.UPGRADER, roles.upgrader)), "securityToken: the upgrader account can upgrade without the timelock");
  const timelock = await connection.ethers.getContractAt("UpgradeTimelock", deployment.contracts.upgradeTimelock);
  expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), roles.upgrader), "upgradeTimelock: proposer role missing");
  expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), roles.upgrader), "upgradeTimelock: executor role missing");
  expect(!(await timelock.hasRole(ROLE.ADMIN, deployer)), "upgradeTimelock: deployer holds the admin role");

  expect(await registry.hasRole(ROLE.REGISTRAR, roles.registrar), "identityRegistry: registrar role missing");
  expect(await registry.isTrustedIssuer(roles.kycIssuer), "identityRegistry: KYC issuer not trusted");
  expect(await dvp.hasRole(ROLE.SETTLEMENT, roles.settlement), "dvpSettlement: settlement role missing");
  expect(await dvp.isSecurityAllowed(deployment.contracts.securityToken), "dvpSettlement: security token not allowed");
  expect(await dvp.isCashAllowed(deployment.contracts.cash), "dvpSettlement: cash token not allowed");
  expect(await dividend.hasRole(ROLE.ISSUER, roles.treasury), "dividendDistributor: issuer role missing");
  expect(await redemption.hasRole(ROLE.ISSUER, roles.treasury), "redemptionManager: issuer role missing");
  expect((await compliance.modules()).length === 3, "compliance: expected three modules");
  return problems;
}
