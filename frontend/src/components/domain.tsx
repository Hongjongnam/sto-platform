"use client";

import { useState } from "react";
import type { ChainEvent, Investor, Operation } from "../lib/api";
import { cash, dateTime, OPERATION_LABELS, shortAddress, shortHash, units } from "../lib/format";
import { useApiQuery } from "../lib/hooks";
import { type Column, Mono, Notice, Rejection, Select, StatusBadge, Table } from "./ui";

export const REASONS: Record<string, string> = {
  PRIMARY_ISSUANCE: "최초 발행",
  ADDITIONAL_ISSUANCE: "추가 발행",
  CAPITAL_REDUCTION: "감자·소각",
  REGISTRATION: "전자등록 반영",
  COURT_ORDER: "법원 명령",
  REGULATORY_HOLD: "감독기관 조치",
  INHERITANCE: "상속",
  LOST_KEY: "키 분실",
  MAINTENANCE: "시스템 점검",
};

export function ReasonSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((code) => (
        <option key={code} value={code}>
          {REASONS[code] ?? code} ({code})
        </option>
      ))}
    </Select>
  );
}

/** Lists every managed wallet as "investor · address". */
export function WalletSelect({ value, onChange, placeholder = "지갑 선택" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const { data: investors } = useApiQuery<Investor[]>("/investors");
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder}</option>
      {investors?.flatMap((investor) =>
        investor.wallets.map((wallet, index) => (
          <option key={wallet.address} value={wallet.address}>
            {investor.name}
            {investor.wallets.length > 1 ? ` (지갑 ${index + 1})` : ""} · {shortAddress(wallet.address)}
          </option>
        )),
      )}
    </Select>
  );
}

/** Resolves a wallet address to "investor name (0x12…ab)". */
export function useWalletNames() {
  const { data: investors } = useApiQuery<Investor[]>("/investors");
  const names = new Map<string, string>();
  for (const investor of investors ?? []) for (const wallet of investor.wallets) names.set(wallet.address, investor.name);
  return (address: string | undefined) => {
    if (!address) return "-";
    const name = names.get(address);
    return name ? `${name} (${shortAddress(address)})` : shortAddress(address);
  };
}

function describeParams(operation: Operation, walletName: (address: string | undefined) => string): string {
  const p = operation.params;
  switch (operation.type) {
    case "MINT":
      return `${walletName(p.to)}에게 ${units(p.amount)}`;
    case "BURN":
      return `${walletName(p.from)}에서 ${units(p.amount)}`;
    case "FREEZE_ADDRESS":
    case "UNFREEZE_ADDRESS":
      return walletName(p.account);
    case "FREEZE_PARTIAL":
    case "UNFREEZE_PARTIAL":
      return `${walletName(p.account)} · ${units(p.amount)}`;
    case "FORCED_TRANSFER":
      return `${walletName(p.from)} → ${walletName(p.to)} · ${units(p.amount)}`;
    case "RECOVERY":
      return `${walletName(p.lostWallet)} → ${walletName(p.newWallet)}`;
    case "SET_REGISTERED_SUPPLY":
      return `${units(p.amount)}`;
    default:
      return "";
  }
}

/** Table of operation requests with approval and execution status; a row expands to show why it was rejected. */
export function OperationsTable({ operations, actions }: { operations: Operation[] | undefined; actions?: (operation: Operation) => React.ReactNode }) {
  const walletName = useWalletNames();
  const [open, setOpen] = useState<string | null>(null);
  const selected = operations?.find((operation) => operation.id === open);

  const columns: Column<Operation>[] = [
    { header: "요청 시각", cell: (row) => dateTime(row.createdAt), width: "150px" },
    { header: "작업", cell: (row) => <b>{OPERATION_LABELS[row.type] ?? row.type}</b> },
    { header: "내용", cell: (row) => describeParams(row, walletName) },
    { header: "사유", cell: (row) => REASONS[row.reasonCode] ?? row.reasonCode },
    { header: "승인", cell: (row) => (row.needsApproval ? <StatusBadge status={row.status} /> : <span className="text-mute">불필요</span>) },
    {
      header: "체인 반영",
      cell: (row) => (row.execution ? <StatusBadge status={row.execution.status} /> : <span className="text-mute">-</span>),
    },
    ...(actions ? [{ header: "", cell: (row: Operation) => actions(row) }] : []),
  ];

  return (
    <div className="space-y-2">
      <Table columns={columns} rows={operations} rowKey={(row) => row.id} onRowClick={(row) => setOpen(open === row.id ? null : row.id)} selectedKey={open ?? undefined} empty="요청 내역이 없습니다." />
      {selected && (
        <div className="space-y-2 border border-line bg-canvas p-2 text-[12px]">
          <p>
            <b>{OPERATION_LABELS[selected.type]}</b> · {describeParams(selected, walletName)}
          </p>
          {selected.evidenceHash && (
            <p className="text-mute">
              근거 문서 해시 <Mono>{shortHash(selected.evidenceHash)}</Mono>
            </p>
          )}
          {selected.needsApproval && selected.decidedAt && (
            <p className="text-mute">
              {selected.status === "APPROVED" ? "승인" : "반려"} {dateTime(selected.decidedAt)} {selected.decisionNote && `· ${selected.decisionNote}`}
            </p>
          )}
          {selected.execution?.txHash && (
            <p className="text-mute">
              트랜잭션 <Mono>{selected.execution.txHash}</Mono> · 블록 {selected.execution.blockNumber}
            </p>
          )}
          {selected.execution?.status === "FAILED" && <Rejection code={selected.execution.errorCode} detail={selected.execution.errorMessage} />}
          {selected.status === "PENDING_APPROVAL" && <Notice>이 작업은 다른 담당자의 승인이 있어야 실행됩니다. 화면 위에서 관점을 “승인 담당자”로 바꾸면 승인할 수 있습니다.</Notice>}
        </div>
      )}
    </div>
  );
}

/** SHA-256 of a text, as a 0x-prefixed hex string: stands in for the hash of a supporting document. */
export async function evidenceHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Returns a function that describes a chain event in one line, with wallets shown by investor name. */
export function useEventSummary(): (event: ChainEvent) => string {
  const walletName = useWalletNames();
  return (event: ChainEvent): string => {
    const a = event.args;
    switch (event.name) {
      case "Transfer":
        return `${walletName(a.from)} → ${walletName(a.to)} · ${units(a.value)}`;
      case "Issued":
        return `${walletName(a.to)}에게 ${units(a.amount)}`;
      case "Redeemed":
        return a.from ? `${walletName(a.from)}에서 ${units(a.amount)}` : `${walletName(a.holder)} · ${units(a.quantity)}단위 / ${cash(a.payout)} USDC`;
      case "ForcedTransfer":
        return `${walletName(a.from)} → ${walletName(a.to)} · ${units(a.amount)}`;
      case "TokensFrozen":
      case "TokensUnfrozen":
        return `${walletName(a.account)} · ${units(a.amount)}`;
      case "AddressFrozen":
        return `${walletName(a.account)} · ${a.frozen === "true" ? "동결" : "해제"}`;
      case "RecoverySuccess":
        return `${walletName(a.lostWallet)} → ${walletName(a.newWallet)} · ${units(a.amount)}`;
      case "IdentityRegistered":
      case "IdentityRevoked":
        return walletName(a.wallet);
      case "RegisteredSupplySet":
        return `${units(a.previous)} → ${units(a.current)}`;
      case "PauseStateChanged":
        return a.paused === "true" ? "정지" : "재개";
      case "TradeCreated":
        return `${walletName(a.seller)} → ${walletName(a.buyer)} · ${units(a.quantity)}단위 / ${cash(a.price)} USDC`;
      case "TradeSettled":
      case "TradeCancelled":
        return `거래 ${shortHash(a.tradeId)}`;
      case "DistributionCreated":
        return `총 ${cash(a.totalAmount)} USDC · 기준 블록 ${units(a.recordBlock)}`;
      case "DividendClaimed":
        return `${walletName(a.holder)} · ${cash(a.amount)} USDC`;
      case "DistributionSwept":
        return `${cash(a.amount)} USDC 회수`;
      case "RedemptionOpened":
        return `1단위당 ${cash(a.pricePerUnit)} USDC`;
      case "Approval":
        return `${walletName(a.owner)} · 한도 ${units(a.value)}`;
      default:
        return "";
    }
  };
}
