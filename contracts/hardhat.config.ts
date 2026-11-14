import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";
import { configVariable, defineConfig } from "hardhat/config";

const compiler = {
  version: "0.8.34",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, hardhatUpgrades],
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
  networks: {
    besu: {
      type: "http",
      chainType: "l1",
      url: configVariable("BESU_RPC_URL"),
      accounts: [configVariable("BESU_DEPLOYER_KEY")],
      gasPrice: 0,
    },
  },
});
