// Deploys every contract and starts the handover to the configured admin.
//
//   npx hardhat run scripts/deploy.ts --network besu
//
// The first account of the network is the deployer. Roles and parameters come from
// scripts/config/local.json, or from the file named by DEPLOY_CONFIG.
import { network } from "hardhat";
import { deployAll, verifyHandover } from "./lib/deploy.js";
import { loadConfig, saveDeployment } from "./lib/files.js";

const connection = await network.create();
const [deployer] = await connection.ethers.getSigners();
const config = loadConfig();

console.log(`network ${connection.networkName}, deployer ${deployer.address}`);
const deployment = await deployAll(connection, deployer, config);
const path = saveDeployment(connection.networkName, deployment);

for (const [name, address] of Object.entries(deployment.contracts)) console.log(`${name.padEnd(28)} ${address}`);
console.log(`start block ${deployment.startBlock}`);
console.log(`recorded in ${path}`);

const pending = await verifyHandover(connection, deployment);
console.log(`\nhandover started; ${pending.length} item(s) wait for the admin (${config.roles.admin}):`);
for (const item of pending) console.log(`  - ${item}`);
console.log("run scripts/accept-handover.ts with the admin account to finish");
