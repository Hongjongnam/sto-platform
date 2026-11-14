import type { BaseContract, Signer } from "ethers";
import { id } from "ethers";

export const REGISTRAR_ROLE = id("REGISTRAR_ROLE");

export const InvestorType = { Retail: 0, Qualified: 1, Professional: 2 } as const;

export const KR = 410;
export const US = 840;

export const ONE_YEAR = 365 * 24 * 60 * 60;

export interface Claim {
  wallet: string;
  investorId: string;
  country: number;
  investorType: number;
  expiry: bigint;
}

/** Deterministic investor identifier for tests. */
export function investorId(label: string): string {
  return id(`investor:${label}`);
}

const CLAIM_TYPES = {
  InvestorClaim: [
    { name: "wallet", type: "address" },
    { name: "investorId", type: "bytes32" },
    { name: "country", type: "uint16" },
    { name: "investorType", type: "uint8" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

/** Signs an InvestorClaim for `registry` as `issuer`. */
export async function signClaim(
  issuer: Signer,
  registry: BaseContract,
  claim: Claim,
  nonce: bigint,
  chainIdOverride?: bigint,
): Promise<string> {
  const chainId = chainIdOverride ?? (await issuer.provider!.getNetwork()).chainId;
  const domain = {
    name: "IdentityRegistry",
    version: "1",
    chainId,
    verifyingContract: await registry.getAddress(),
  };
  return issuer.signTypedData(domain, CLAIM_TYPES, { ...claim, nonce });
}
