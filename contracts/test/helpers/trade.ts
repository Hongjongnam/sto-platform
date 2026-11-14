import type { BaseContract, Signer } from "ethers";
import { id } from "ethers";

export const SETTLEMENT_ROLE = id("SETTLEMENT_ROLE");

export interface TradeTerms {
  tradeId: string;
  seller: string;
  buyer: string;
  security: string;
  cash: string;
  quantity: bigint;
  price: bigint;
  expiry: bigint;
}

/** Trade identifier derived from an off-chain trade number. */
export function tradeId(tradeNumber: string): string {
  return id(tradeNumber);
}

const TRADE_TYPES = {
  Trade: [
    { name: "tradeId", type: "bytes32" },
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "security", type: "address" },
    { name: "cash", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};

/** Signs trade terms for `dvp` as `party`. */
export async function signTrade(party: Signer, dvp: BaseContract, terms: TradeTerms): Promise<string> {
  const { chainId } = await party.provider!.getNetwork();
  const domain = { name: "DvPSettlement", version: "1", chainId, verifyingContract: await dvp.getAddress() };
  return party.signTypedData(domain, TRADE_TYPES, terms);
}
