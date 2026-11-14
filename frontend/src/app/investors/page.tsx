"use client";

import { useState } from "react";
import type { Investor, WalletView } from "../../lib/api";
import { dateTime, INVESTOR_TYPES } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Button, type Column, Field, Input, Mono, Notice, Panel, Rejection, Select, StatusBadge, Table } from "../../components/ui";

export default function InvestorsPage() {
  const { call, perspective } = useSession();
  const { waitUntil } = useChainActions();
  const { data: investors } = useApiQuery<Investor[]>("/investors");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [investorType, setInvestorType] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = investors?.find((investor) => investor.id === selectedId) ?? null;
  const canAct = perspective === "requester";

  /** Runs an identity action and waits until none of the investor's wallets is still pending. */
  const run = async (action: () => Promise<Investor>) => {
    setBusy(true);
    setError(null);
    try {
      const investor = await action();
      setSelectedId(investor.id);
      await waitUntil(
        () => call<Investor>(`/investors/${investor.id}`),
        (latest) => latest.wallets.every((wallet) => wallet.kycStatus !== "PENDING"),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Investor>[] = [
    { header: "투자자", cell: (row) => <b>{row.name}</b> },
    { header: "유형", cell: (row) => INVESTOR_TYPES[row.investorType] },
    { header: "국가", cell: (row) => (row.country === 410 ? "대한민국" : row.country) },
    { header: "지갑", cell: (row) => `${row.wallets.length}개`, numeric: true },
    {
      header: "KYC",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.wallets.map((wallet) => (
            <StatusBadge key={wallet.address} status={wallet.kycStatus} />
          ))}
        </span>
      ),
    },
  ];
  const walletColumns: Column<WalletView>[] = [
    { header: "지갑 주소", cell: (row) => <Mono>{row.address}</Mono> },
    { header: "KYC", cell: (row) => <StatusBadge status={row.kycStatus} /> },
    { header: "만료", cell: (row) => dateTime(row.kycExpiry) },
    {
      header: "",
      cell: (row) =>
        canAct && (
          <span className="flex justify-end gap-1">
            <Button variant="ghost" disabled={busy} onClick={() => run(() => call<Investor>(`/wallets/${row.address}/renew`, { method: "POST" }))}>
              갱신
            </Button>
            <Button variant="ghost" disabled={busy || row.kycStatus !== "VERIFIED"} onClick={() => run(() => call<Investor>(`/wallets/${row.address}/revoke`, { body: { reason: "KYC_WITHDRAWN" } }))}>
              철회
            </Button>
          </span>
        ),
    },
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
      <div className="space-y-3">
        <Panel title="투자자 목록">
          <Table columns={columns} rows={investors} rowKey={(row) => row.id} onRowClick={(row) => setSelectedId(row.id)} selectedKey={selectedId ?? undefined} empty="등록된 투자자가 없습니다." />
        </Panel>
        {selected && (
          <Panel
            title={`${selected.name} · 지갑`}
            action={
              canAct && (
                <Button variant="ghost" disabled={busy} onClick={() => run(() => call<Investor>(`/investors/${selected.id}/wallets`, { method: "POST" }))}>
                  지갑 추가
                </Button>
              )
            }
          >
            <p className="mb-2 text-[11px] text-mute">
              온체인 투자자 식별자 <Mono>{selected.investorId}</Mono>
            </p>
            <Table columns={walletColumns} rows={selected.wallets} rowKey={(row) => row.address} />
            {selected.wallets
              .filter((wallet) => wallet.failure)
              .map((wallet) => (
                <div key={wallet.address} className="mt-2">
                  <Rejection code={wallet.failure!.split(":")[0]} detail={wallet.failure} />
                </div>
              ))}
          </Panel>
        )}
      </div>
      <div className="space-y-3">
        <Panel title="투자자 등록 (KYC)">
          {canAct ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => call<Investor>("/investors", { body: { name: name.trim(), country: 410, investorType: Number(investorType) } })).then(() => setName(""));
              }}
            >
              <Field label="이름 (가상의 이름을 쓰세요)">
                <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required placeholder="예: 김투자" />
              </Field>
              <Field label="투자자 유형" hint="유형마다 보유 한도가 다릅니다: 일반 1,000 · 적격 10,000 · 전문 100,000">
                <Select value={investorType} onChange={(event) => setInvestorType(event.target.value)}>
                  {INVESTOR_TYPES.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "체인에 등록하는 중…" : "등록"}
              </Button>
            </form>
          ) : (
            <Notice>투자자 등록은 “요청 담당자” 관점에서 할 수 있습니다.</Notice>
          )}
          {error && <p className="mt-2 text-no">{error}</p>}
        </Panel>
        <Notice>
          <b>여기서 일어나는 일</b>
          <br />
          등록하면 ① 투자자용 지갑이 만들어지고 ② KYC 기관 역할의 키가 “이 지갑은 이 투자자의 것이고 언제까지 유효하다”는 내용에 서명하고 ③ 그 서명이 온체인 신원
          레지스트리에 기록됩니다. 이름 같은 개인정보는 체인에 올라가지 않고, 체인에는 뜻을 알 수 없는 투자자 식별자만 남습니다. 한 투자자가 지갑을 여러 개 가져도
          보유 한도는 투자자 단위로 합산됩니다.
        </Notice>
      </div>
    </div>
  );
}
