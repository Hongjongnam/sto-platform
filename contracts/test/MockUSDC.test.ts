import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

describe("MockUSDC", function () {
  async function deployFixture() {
    const [deployer, alice] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockUSDC");
    return { usdc, deployer, alice };
  }

  it("uses 6 decimals", async function () {
    const { usdc } = await networkHelpers.loadFixture(deployFixture);
    expect(await usdc.decimals()).to.equal(6n);
  });

  it("mints to any address", async function () {
    const { usdc, alice } = await networkHelpers.loadFixture(deployFixture);
    await usdc.mint(alice.address, 1_000_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(1_000_000n);
    expect(await usdc.totalSupply()).to.equal(1_000_000n);
  });
});
