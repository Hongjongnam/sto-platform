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
    // `npx hardhat node --port 8546`; used by the backend's integration tests.
    local: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8546",
      accounts: { mnemonic: "test test test test test test test test test test test junk", count: 20 },
    },
    besu: {
      type: "http",
      chainType: "l1",
      url: configVariable("BESU_RPC_URL"),
      accounts: { mnemonic: configVariable("BESU_MNEMONIC"), count: 20 },
      gasPrice: 0,
    },
  },
});
