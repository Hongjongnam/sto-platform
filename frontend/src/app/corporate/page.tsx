"use client";

import { useState } from "react";
import type { CorporateAction } from "../../lib/api";
import { cash, dateTime, explain, toCashUnits, units } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { useWalletNames, WalletSelect } from "../../components/domain";
import { Button, type Column, Field, Input, Notice, Panel, Rejection, StatusBadge, Table } from "../../components/ui";

type Claim = CorporateAction["claims"][number];

export default function CorporatePage() {
  const { call, perspective } = useSession();
  const { waitUntil } = useChainActions();
  const { data: dividends } = useApiQuery<CorporateAction[]>("/dividends");
  const { data: redemptions } = useApiQuery<CorporateAction[]>("/redemptions");
  const walletName = useWalletNames();
  const [dividendTotal, setDividendTotal] = useState("");
  const [price, setPrice] = useState("");
  const [claim, setClaim] = useState({ wallet: "", quantity: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAct = perspective !== "approver";
  const all = [...(dividends ?? []), ...(redemptions ?? [])];
  const selected = all.find((action) => action.id === openId);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const path = (action: CorporateAction) => (action.kind === "DIVIDEND" ? "dividends" : "redemptions");
  const open = (kind: "dividends" | "redemptions", body: object) =>
    guard(async () => {
      const created = await call<CorporateAction>(`/${kind}`, { body });
      setOpenId(created.id);
      await waitUntil(
        () => call<CorporateAction>(`/${kind}/${created.id}`),
        (action) => action.status !== "OPENING",
      );
    });
  const submitClaim = (action: CorporateAction) =>
    guard(async () => {
      const body = action.kind === "DIVIDEND" ? { wallet: claim.wallet } : { wallet: claim.wallet, quantity: claim.quantity };
      const before = action.claims.length;
      await call(`/${path(action)}/${action.id}/${action.kind === "DIVIDEND" ? "claims" : "redeem"}`, { body });
      await waitUntil(
        () => call<CorporateAction>(`/${path(action)}/${action.id}`),
        (latest) => latest.claims.length > before && latest.claims.every((item) => item.status === "CONFIRMED" || item.status === "FAILED"),
      );
    });

  const columns = (kind: "DIVIDEND" | "REDEMPTION"): Column<CorporateAction>[] => [
    { header: "개설", cell: (row) => dateTime(row.createdAt) },
    { header: kind === "DIVIDEND" ? "배당 총액(USDC)" : "1단위 상환가(USDC)", cell: (row) => cash(row.amount), numeric: true },
    ...(kind === "DIVIDEND" ? [{ header: "기준 블록", cell: (row: CorporateAction) => (row.recordBlock ? units(row.recordBlock) : "-"), numeric: true }] : []),
    { header: "마감", cell: (row) => dateTime(row.deadline) },
    { header: "청구", cell: (row) => `${row.claims.filter((item) => item.status === "CONFIRMED").length}건`, numeric: true },
    { header: "상태", cell: (row) => <StatusBadge status={row.status} /> },
  ];
  const claimColumns: Column<Claim>[] = [
    { header: "지갑", cell: (row) => walletName(row.wallet) },
    ...(selected?.kind === "REDEMPTION" ? [{ header: "상환 수량", cell: (row: Claim) => units(row.quantity), numeric: true }] : []),
    { header: "지급액(USDC)", cell: (row) => cash(row.paid), numeric: true },
    { header: "결과", cell: (row) => (row.status === "FAILED" ? <span className="text-no">{explain(row.errorCode).title}</span> : <StatusBadge status={row.status} />) },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <b>권리행사.</b> 배당은 <b>기준 블록</b> 시점의 보유 비율대로 나누고, 투자자가 각자 청구해서 받아 갑니다(한 번에 일괄 송금하지 않으므로 한 명의 실패가 전체를
        막지 않습니다). 기준 블록 이후에 사고판 수량은 영향을 주지 않습니다. 상환은 증권을 소각하면서 같은 트랜잭션에서 대금을 지급합니다. 동결된 계좌와 동결된
        수량은 배당도 상환도 받을 수 없습니다.
      </Notice>
      <div className="grid gap-3 md:grid-cols-2">
        <Panel title="배당 개설">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void open("dividends", { totalAmount: toCashUnits(dividendTotal), claimDays: 30 });
            }}
          >
            <div className="flex-1">
              <Field label="배당 총액 (USDC)" hint="현재 블록의 보유 비율대로 나눕니다. 청구 기간 30일">
                <Input inputMode="numeric" pattern="[1-9][0-9]*" value={dividendTotal} onChange={(event) => setDividendTotal(event.target.value)} required />
              </Field>
            </div>
            <Button type="submit" disabled={perspective !== "requester" || busy || !dividendTotal}>
              개설
            </Button>
          </form>
        </Panel>
        <Panel title="상환 개설">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void open("redemptions", { pricePerUnit: toCashUnits(price), claimDays: 30 });
            }}
          >
            <div className="flex-1">
              <Field label="1단위당 상환가 (USDC)" hint="발행 총량 전체를 상환할 수 있는 금액이 예치됩니다">
                <Input inputMode="numeric" pattern="[1-9][0-9]*" value={price} onChange={(event) => setPrice(event.target.value)} required />
              </Field>
            </div>
            <Button type="submit" disabled={perspective !== "requester" || busy || !price}>
              개설
            </Button>
          </form>
        </Panel>
      </div>
      {busy && <Notice>체인에 반영되기를 기다리는 중입니다…</Notice>}
      {error && <p className="text-no">{error}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="배당">
          <Table columns={columns("DIVIDEND")} rows={dividends} rowKey={(row) => row.id} onRowClick={(row) => setOpenId(row.id)} selectedKey={openId ?? undefined} empty="개설된 배당이 없습니다." />
        </Panel>
        <Panel title="상환">
          <Table columns={columns("REDEMPTION")} rows={redemptions} rowKey={(row) => row.id} onRowClick={(row) => setOpenId(row.id)} selectedKey={openId ?? undefined} empty="개설된 상환이 없습니다." />
        </Panel>
      </div>
      {selected && (
        <Panel title={`${selected.kind === "DIVIDEND" ? "배당" : "상환"} 상세 · 청구 내역`}>
          {selected.failure && <Rejection code={selected.failure.split(":")[0]} detail={selected.failure} />}
          {selected.status === "OPEN" && canAct && (
            <form
              className="mb-3 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitClaim(selected);
              }}
            >
              <div className="min-w-[220px] flex-1">
                <Field label="청구할 투자자 지갑">
                  <WalletSelect value={claim.wallet} onChange={(wallet) => setClaim({ ...claim, wallet })} />
                </Field>
              </div>
              {selected.kind === "REDEMPTION" && (
                <div className="w-32">
                  <Field label="상환 수량">
                    <Input inputMode="numeric" pattern="[1-9][0-9]*" value={claim.quantity} onChange={(event) => setClaim({ ...claim, quantity: event.target.value })} required />
                  </Field>
                </div>
              )}
              <Button type="submit" disabled={busy || !claim.wallet || (selected.kind === "REDEMPTION" && !claim.quantity)}>
                {selected.kind === "DIVIDEND" ? "배당 청구" : "상환 청구"}
              </Button>
            </form>
          )}
          <Table columns={claimColumns} rows={selected.claims} rowKey={(row) => `${row.wallet}-${selected.claims.indexOf(row)}`} empty="아직 청구가 없습니다." />
          {selected.claims
            .filter((item) => item.status === "FAILED")
            .slice(-1)
            .map((item) => (
              <div key="last-failure" className="mt-2">
                <Rejection code={item.errorCode} />
              </div>
            ))}
        </Panel>
      )}
    </div>
  );
}
