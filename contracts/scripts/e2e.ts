// End-to-end scenario against a deployed system: KYC, issuance, transfers, rejected
// operations, freeze, DvP settlement, dividend, forced transfer, wallet recovery and
// redemption. Every step checks its outcome and the script fails on the first mismatch.
//
//   npx hardhat run scripts/e2e.ts --network besu
//
// Expects a fresh deployment (scripts/deploy.ts and scripts/accept-handover.ts) and the
// development mnemonic: accounts 0-9 hold the roles in scripts/config/local.json and
// accounts 10-14 act as investors.
import { type BaseContract, encodeBytes32String, id } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { network } from "hardhat";
import { type Claim, InvestorType, investorId, KR, ONE_YEAR, signClaim } from "../test/helpers/identity.js";
import { signTrade, type TradeTerms } from "../test/helpers/trade.js";
import { attach } from "./lib/deploy.js";
import { loadDeployment } from "./lib/files.js";

const connection = await network.create();
const { ethers } = connection;
const deployment = loadDeployment(connection.networkName);
const signers = await ethers.getSigners();
const byAddress = (address: string): HardhatEthersSigner => {
  const signer = signers.find((s) => s.address === address);
  if (!signer) throw new Error(`account ${address} is not available on this network connection`);
  return signer;
};

const issuer = byAddress(deployment.roles.issuer);
const enforcer = byAddress(deployment.roles.enforcer);
const registrar = byAddress(deployment.roles.registrar);
const settlement = byAddress(deployment.roles.settlement);
const kycIssuer = byAddress(deployment.roles.kycIssuer);
const treasury = byAddress(deployment.roles.treasury);
const [alice, bob, carol, outsider, aliceNew] = signers.slice(10, 15);

const { registry, token, cash, dvp, dividend, redemption } = await attach(connection, deployment);
const REASON = encodeBytes32String("E2E");
const UNIT = 1_000_000n; // 1 USDC

let stepNumber = 0;
const step = (title: string) => console.log(`\n[${++stepNumber}] ${title}`);
const ok = (message: string) => console.log(`    ok   ${message}`);
const send = async (tx: Promise<{ wait(): Promise<unknown> }>) => (await tx).wait();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
  ok(message);
}

/**
 * Expects `action` to be rejected with the custom error `errorName` declared by `contract`.
 * The node returns the raw revert data, which is decoded here against the contract's ABI.
 */
async function rejected(
  contract: BaseContract,
  action: () => Promise<unknown>,
  errorName: string,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    const decoded = typeof data === "string" ? contract.interface.parseError(data)?.name : undefined;
    if (decoded !== errorName) {
      throw new Error(`expected ${errorName} but got ${decoded ?? String(error).slice(0, 300)}`);
    }
    console.log(`    ok   rejected (${errorName}): ${message}`);
    return;
  }
  throw new Error(`expected ${errorName} but the call succeeded: ${message}`);
}

async function now(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

async function kyc(wallet: HardhatEthersSigner, label: string): Promise<void> {
  const claim: Claim = {
    wallet: wallet.address,
    investorId: investorId(label),
    country: KR,
    investorType: InvestorType.Retail,
    expiry: (await now()) + BigInt(ONE_YEAR),
  };
  const signature = await signClaim(kycIssuer, registry, claim, await registry.nonces(wallet.address));
  await send(registry.connect(registrar).registerIdentity(claim, signature));
}

step("Registered supply and KYC");
await send(token.connect(registrar).setRegisteredSupply(1_000_000n, REASON));
for (const [wallet, label] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]] as const) await kyc(wallet, label);
check(await registry.isVerified(alice.address), "alice, bob and carol are verified investors");
check(!(await registry.isVerified(outsider.address)), "the outsider wallet is not verified");

step("Issuance");
await send(token.connect(issuer).mint(alice.address, 500n, REASON));
await send(token.connect(issuer).mint(bob.address, 100n, REASON));
check((await token.totalSupply()) === 600n, "600 units issued to alice (500) and bob (100)");
await rejected(token, () => token.connect(issuer).mint(outsider.address, 1n, REASON), "NotVerified", "mint to an unverified wallet");
await rejected(token, () => token.connect(issuer).mint(bob.address, 901n, REASON), "ComplianceRejected", "mint above the retail holding cap");

step("Transfers");
await send(token.connect(alice).transfer(bob.address, 50n));
check((await token.balanceOf(bob.address)) === 150n, "alice transferred 50 units to bob");
await rejected(token, () => token.connect(alice).transfer(outsider.address, 1n), "NotVerified", "transfer to an unverified wallet");

step("Partial freeze");
await send(token.connect(enforcer).freezePartialTokens(alice.address, 400n, REASON));
check((await token.freeBalanceOf(alice.address)) === 50n, "400 of alice's 450 units are frozen");
await rejected(token, () => token.connect(alice).transfer(bob.address, 51n), "InsufficientFreeBalance", "transfer of frozen units");
await send(token.connect(enforcer).unfreezePartialTokens(alice.address, 400n, REASON));

step("DvP settlement");
const price = 1_000n * UNIT;
await send(cash.connect(treasury).mint(carol.address, price));
const terms: TradeTerms = {
  tradeId: id(`E2E-${deployment.startBlock}-0001`),
  seller: alice.address,
  buyer: carol.address,
  security: deployment.contracts.securityToken,
  cash: deployment.contracts.cash,
  quantity: 10n,
  price,
  expiry: (await now()) + 3600n,
};
const sellerSignature = await signTrade(alice, dvp, terms);
const buyerSignature = await signTrade(carol, dvp, terms);
await send(dvp.connect(settlement).createTrade(terms, sellerSignature, buyerSignature));
await send(token.connect(alice).approve(deployment.contracts.dvpSettlement, terms.quantity));
await send(cash.connect(carol).approve(deployment.contracts.dvpSettlement, price));
await send(dvp.connect(settlement).settle(terms.tradeId));
check((await token.balanceOf(carol.address)) === 10n, "carol received 10 units");
check((await cash.balanceOf(alice.address)) === price, "alice received 1,000 USDC");
await rejected(dvp, () => dvp.connect(settlement).createTrade(terms, sellerSignature, buyerSignature), "TradeExists", "reuse of a trade number");

step("Dividend");
const recordBlock = await ethers.provider.getBlockNumber();
const dividendTotal = 6_000n * UNIT;
await send(cash.connect(treasury).mint(treasury.address, dividendTotal));
await send(cash.connect(treasury).approve(deployment.contracts.dividendDistributor, dividendTotal));
const distributionId = await dividend.distributionCount();
await send(
  dividend
    .connect(treasury)
    .createDistribution(deployment.contracts.securityToken, deployment.contracts.cash, recordBlock, await now(), dividendTotal, (await now()) + 86_400n),
);
const aliceCashBefore = await cash.balanceOf(alice.address);
for (const holder of [alice, bob, carol]) await send(dividend.connect(holder).claim(distributionId));
// Record-block holdings: alice 440, bob 150, carol 10 of 600.
check((await cash.balanceOf(alice.address)) - aliceCashBefore === 4_400n * UNIT, "alice claimed 4,400 USDC for 440 of 600 units");
check((await cash.balanceOf(bob.address)) === 1_500n * UNIT, "bob claimed 1,500 USDC for 150 of 600 units");
await rejected(dividend, () => dividend.connect(alice).claim(distributionId), "AlreadyClaimed", "second claim of the same distribution");

step("Account freeze and forced transfer");
await send(token.connect(enforcer).setAddressFrozen(bob.address, true, REASON));
await rejected(token, () => token.connect(bob).transfer(alice.address, 1n), "AccountFrozen", "transfer from a frozen account");
await send(token.connect(enforcer).forcedTransfer(bob.address, carol.address, 20n, encodeBytes32String("COURT_ORDER")));
check((await token.balanceOf(carol.address)) === 30n, "20 units were moved from bob's frozen account to carol");
await send(token.connect(enforcer).setAddressFrozen(bob.address, false, REASON));

step("Wallet recovery");
await kyc(aliceNew, "alice");
const holdersBefore = await token.holderCount();
await send(token.connect(enforcer).recoveryAddress(alice.address, aliceNew.address, encodeBytes32String("LOST_KEY")));
check((await token.balanceOf(aliceNew.address)) === 440n && (await token.balanceOf(alice.address)) === 0n, "alice's 440 units moved to her new wallet");
check((await token.holderCount()) === holdersBefore, "the number of holders did not change");

step("Redemption");
const supply = await token.totalSupply();
await send(cash.connect(treasury).mint(treasury.address, supply * UNIT));
await send(cash.connect(treasury).approve(deployment.contracts.redemptionManager, supply * UNIT));
const roundId = await redemption.roundCount();
await send(redemption.connect(treasury).openRedemption(deployment.contracts.securityToken, deployment.contracts.cash, UNIT, (await now()) + 86_400n));
const carolCashBefore = await cash.balanceOf(carol.address);
await send(redemption.connect(carol).redeem(roundId, 30n));
check((await token.balanceOf(carol.address)) === 0n, "carol's 30 units were cancelled");
check((await cash.balanceOf(carol.address)) - carolCashBefore === 30n * UNIT, "carol received 30 USDC");

step("Final state");
let sum = 0n;
for (const wallet of [alice, aliceNew, bob, carol, outsider]) sum += await token.balanceOf(wallet.address);
check(sum === (await token.totalSupply()), `wallet balances add up to the total supply (${sum})`);
check((await token.holderCount()) === 2n, "two investors still hold units (alice and bob)");
check((await token.investorBalanceOf(investorId("alice"))) === 440n, "alice's investor balance is 440 across her wallets");
console.log("\nscenario completed");
