import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { encodeBytes32String, id } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";
import { type Claim, InvestorType, investorId, KR, ONE_YEAR, REGISTRAR_ROLE, signClaim } from "./identity.js";

export const ISSUER_ROLE = id("ISSUER_ROLE");
export const ENFORCER_ROLE = id("ENFORCER_ROLE");
export const PAUSER_ROLE = id("PAUSER_ROLE");
export const UPGRADER_ROLE = id("UPGRADER_ROLE");

export const REASON = encodeBytes32String("TEST");

export const RETAIL_LIMIT = 1_000n;
export const QUALIFIED_LIMIT = 10_000n;
export const PROFESSIONAL_LIMIT = 100_000n;
export const MAX_HOLDERS = 5n;
export const REGISTERED_SUPPLY = 1_000_000n;

/**
 * Deploys the registry, compliance with the balance and holder modules, and the token behind
 * a UUPS proxy, with one signer per role.
 */
export async function deploySystem(connection: NetworkConnection) {
  const { ethers, networkHelpers } = connection;
  const upgradesApi = await upgrades(hre, connection);
  const [admin, issuerOp, enforcer, pauser, registrar, upgrader, kycIssuer, alice, aliceSecond, bob, carol, dave, erin, frank, outsider] =
    await ethers.getSigners();

  const registry = await ethers.deployContract("IdentityRegistry", [admin.address]);
  await registry.grantRole(REGISTRAR_ROLE, registrar.address);
  await registry.setTrustedIssuer(kycIssuer.address, true);

  const compliance = await ethers.deployContract("ModularCompliance", [admin.address]);
  const maxBalance = await ethers.deployContract("MaxBalanceModule", [admin.address]);
  await maxBalance.setMaxBalance(InvestorType.Retail, RETAIL_LIMIT);
  await maxBalance.setMaxBalance(InvestorType.Qualified, QUALIFIED_LIMIT);
  await maxBalance.setMaxBalance(InvestorType.Professional, PROFESSIONAL_LIMIT);
  const maxHolders = await ethers.deployContract("MaxHoldersModule", [admin.address, MAX_HOLDERS]);
  await compliance.addModule(await maxBalance.getAddress());
  await compliance.addModule(await maxHolders.getAddress());

  const factory = await ethers.getContractFactory("SecurityToken");
  const proxy = await upgradesApi.deployProxy(
    factory,
    ["Example Fund Unit", "EFU", admin.address, 0, await registry.getAddress(), await compliance.getAddress()],
    { kind: "uups" },
  );
  const token = await ethers.getContractAt("SecurityToken", await proxy.getAddress());
  await token.grantRole(ISSUER_ROLE, issuerOp.address);
  await token.grantRole(ENFORCER_ROLE, enforcer.address);
  await token.grantRole(PAUSER_ROLE, pauser.address);
  await token.grantRole(REGISTRAR_ROLE, registrar.address);
  await token.grantRole(UPGRADER_ROLE, upgrader.address);
  await token.connect(registrar).setRegisteredSupply(REGISTERED_SUPPLY, REASON);

  /** Registers `wallet` for the investor named `label`. */
  async function kyc(wallet: HardhatEthersSigner, label: string, overrides: Partial<Claim> = {}) {
    const claim: Claim = {
      wallet: wallet.address,
      investorId: investorId(label),
      country: KR,
      investorType: InvestorType.Retail,
      expiry: BigInt(await networkHelpers.time.latest()) + BigInt(ONE_YEAR),
      ...overrides,
    };
    const signature = await signClaim(kycIssuer, registry, claim, await registry.nonces(wallet.address));
    await registry.connect(registrar).registerIdentity(claim, signature);
    return claim;
  }

  const mint = (to: HardhatEthersSigner, amount: bigint) => token.connect(issuerOp).mint(to.address, amount, REASON);

  return {
    upgradesApi,
    registry,
    compliance,
    maxBalance,
    maxHolders,
    token,
    admin,
    issuerOp,
    enforcer,
    pauser,
    registrar,
    upgrader,
    kycIssuer,
    alice,
    aliceSecond,
    bob,
    carol,
    dave,
    erin,
    frank,
    outsider,
    kyc,
    mint,
  };
}
