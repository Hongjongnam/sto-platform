"use client";

import { useState } from "react";
import type { ChainEvent } from "../../lib/api";
import { EVENT_LABELS, reasonText, shortAddress, units } from "../../lib/format";
import { useApiQuery } from "../../lib/hooks";
import { REASONS, useEventSummary, WalletSelect } from "../../components/domain";
import { type Column, Field, Mono, Notice, Panel, Select, Table } from "../../components/ui";

const PRIVILEGED = ["Issued", "Redeemed", "AddressFrozen", "TokensFrozen", "TokensUnfrozen", "ForcedTransfer", "RecoverySuccess", "PauseStateChanged", "RegisteredSupplySet", "IdentityRegistered", "IdentityRevoked", "TradeSettled", "TradeCancelled"];

export default function AuditPage() {
  const [name, setName] = useState("");
  const [wallet, setWallet] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const query = new URLSearchParams({ limit: "200", ...(name ? { name } : {}), ...(wallet ? { address: wallet } : {}) });
  const { data: events } = useApiQuery<ChainEvent[]>(`/events?${query}`);
  const selected = events?.find((event) => event.id === openId);

  const summary = useEventSummary();

  const columns: Column<ChainEvent>[] = [
    { header: "블록", cell: (row) => units(row.blockNumber), numeric: true, width: "70px" },
    { header: "이벤트", cell: (row) => <b className={PRIVILEGED.includes(row.name) ? "text-navy" : "font-normal text-mute"}>{EVENT_LABELS[row.name] ?? row.name}</b> },
    { header: "내용", cell: summary },
    { header: "실행 계정", cell: (row) => (row.args.operator ? <Mono>{shortAddress(row.args.operator)}</Mono> : <span className="text-mute">-</span>) },
    {
      header: "사유",
      cell: (row) => {
        if (!row.args.reason) return <span className="text-mute">-</span>;
        const code = reasonText(row.args.reason);
        return REASONS[code] ?? code;
      },
    },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <b>감사 추적.</b> 발행, 동결, 강제이전 같은 특권 작업은 모두 <b>누가(실행 계정)</b>, <b>왜(사유)</b> 했는지를 담은 이벤트를 체인에 남깁니다. 이 화면은 그
        이벤트를 그대로 읽어 온 것이며, 회사 내부에서 지우거나 고칠 수 없는 기록입니다.
      </Notice>
      <Panel title="조회 조건">
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="이벤트 종류">
            <Select value={name} onChange={(event) => setName(event.target.value)}>
              <option value="">전체</option>
              {Object.entries(EVENT_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label} ({key})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="관련 지갑">
            <WalletSelect value={wallet} onChange={setWallet} placeholder="전체" />
          </Field>
        </div>
      </Panel>
      <Panel title={`체인 이벤트 ${events ? `(${events.length}건, 최신순)` : ""}`}>
        <Table columns={columns} rows={events} rowKey={(row) => String(row.id)} onRowClick={(row) => setOpenId(openId === row.id ? null : row.id)} selectedKey={openId === null ? undefined : String(openId)} empty="조건에 맞는 이벤트가 없습니다." />
        {selected && (
          <div className="mt-2 border border-line bg-canvas p-2 text-[11px]">
            <p>
              {selected.contract}.{selected.name} · 트랜잭션 <Mono>{selected.txHash}</Mono> · 로그 #{selected.logIndex}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
              {Object.entries(selected.args).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-mute">{key}</dt>
                  <dd className="break-all font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </Panel>
    </div>
  );
}
