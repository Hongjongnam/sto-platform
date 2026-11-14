// Smoke test for a live network: deploys USDC, mints, and checks that an
// account outside the node allowlist cannot submit transactions.
//
//   BESU_RPC_URL=http://127.0.0.1:8545 BESU_DEPLOYER_KEY=0x... \
//     npx hardhat run scripts/network-smoke.ts --network besu
import { network } from "hardhat";

const { ethers } = await network.create();
const [deployer] = await ethers.getSigners();
const { chainId } = await ethers.provider.getNetwork();
const feeData = await ethers.provider.getFeeData();
console.log(`chainId ${chainId}, deployer ${deployer.address}, gasPrice ${feeData.gasPrice}`);

const usdc = await ethers.deployContract("USDC");
await usdc.waitForDeployment();
const address = await usdc.getAddress();
const deployTx = usdc.deploymentTransaction();
const receipt = await deployTx!.wait();
console.log(`USDC deployed at ${address} in block ${receipt!.blockNumber}`);

await (await usdc.mint(deployer.address, 1_000_000n)).wait();
const balance = await usdc.balanceOf(deployer.address);
if (balance !== 1_000_000n) throw new Error(`unexpected balance ${balance}`);
console.log(`minted, balance ${balance}`);

const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
const blocked = await usdc
  .connect(outsider)
  .mint(outsider.address, 1n, { gasPrice: 0n, gasLimit: 100_000n })
  .then(() => false)
  .catch(() => true);
if (!blocked) throw new Error("transaction from a non-allowlisted account was accepted");
console.log("non-allowlisted account rejected");
