/** Error returned by the API, with the HTTP status and the server's message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(", ") : (data?.message ?? response.statusText);
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export interface Execution {
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  txHash: string | null;
  blockNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface Operation {
  id: string;
  type: string;
  params: Record<string, string>;
  reasonCode: string;
  evidenceHash: string | null;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  needsApproval: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  execution: Execution | null;
}

export interface WalletView {
  address: string;
  kycStatus: "PENDING" | "VERIFIED" | "EXPIRED" | "REVOKED" | "FAILED";
  kycExpiry: string;
  failure: string | null;
}

export interface Investor {
  id: string;
  investorId: string;
  name: string;
  country: number;
  investorType: number;
  wallets: WalletView[];
}

export interface Holding {
  wallet: string;
  balance: string;
  frozen: string;
  addressFrozen: boolean;
  updatedBlock: number;
  investorUuid: string | null;
  investorName: string | null;
}

export interface LedgerState {
  totalSupply: string;
  registeredSupply: string;
  paused: boolean;
  holders: number;
  indexedBlock: number;
  chainBlock: number;
}

export interface ChainEvent {
  id: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  contract: string;
  name: string;
  args: Record<string, string>;
}

export interface Trade {
  id: string;
  tradeNo: string;
  tradeId: string;
  seller: string;
  buyer: string;
  quantity: string;
  price: string;
  expiry: string;
  status: "PENDING" | "SETTLED" | "FAILED" | "CANCELLING" | "CANCELLED";
  settleAttempts: number;
  txHash: string | null;
  failure: { step: string; errorCode: string | null; errorMessage: string | null } | null;
  createdAt: string;
}

export interface ReconReport {
  id: string;
  blockNumber: number;
  ok: boolean;
  walletsChecked: number;
  mismatches: { field: string; subject?: string; ledger: string; chain: string }[];
  createdAt: string;
}

export interface CorporateAction {
  id: string;
  kind: "DIVIDEND" | "REDEMPTION";
  amount: string;
  recordBlock: number | null;
  deadline: string;
  status: "OPENING" | "OPEN" | "FAILED" | "CLOSING" | "CLOSED";
  onChainId: string | null;
  failure: string | null;
  claims: { wallet: string; quantity: string | null; status: Execution["status"]; paid: string | null; errorCode: string | null }[];
  createdAt: string;
}

export interface Portfolio {
  wallet: string;
  balance: string;
  frozen: string;
  free: string;
  addressFrozen: boolean;
  cash: string;
  verified: boolean;
}

export interface Transaction extends Execution {
  id: string;
  contract: string;
  method: string;
  signer: string;
}
