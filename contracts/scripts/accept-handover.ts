// Run with the admin account: accepts the pending ownership and admin transfers, then checks
// that the deployer holds no privileges anywhere.
//
//   npx hardhat run scripts/accept-handover.ts --network besu
import { network } from "hardhat";
import { acceptHandover, verifyHandover } from "./lib/deploy.js";
import { loadConfig, loadDeployment } from "./lib/files.js";

const connection = await network.create();
const deployment = loadDeployment(connection.networkName);
const config = loadConfig();

const signers = await connection.ethers.getSigners();
const admin = signers.find((signer) => signer.address === deployment.roles.admin);
if (!admin) throw new Error(`the admin account ${deployment.roles.admin} is not available on this network connection`);

await acceptHandover(connection, deployment, admin, config.token.adminTransferDelay);

const problems = await verifyHandover(connection, deployment);
if (problems.length > 0) {
  for (const problem of problems) console.error(`  - ${problem}`);
  throw new Error("handover verification failed");
}
console.log("handover complete: the admin controls every contract and the deployer holds no privileges");
