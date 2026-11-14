"use client";

import { useState } from "react";
import type { Trade } from "../../lib/api";
import { cash, dateTime, toCashUnits, units } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { useWalletNames, WalletSelect } from "../../components/domain";
import { Button, type Column, Field, Input, Mono, Notice, Panel, Rejection, StatusBadge, Table } from "../../components/ui";

export default function TradesPage() {
  const { call, perspective } = useSession();
  const { waitUntil, waitForTransaction } = useChainActions();
  const { data: trades } = useApiQuery<Trade[]>("/trades");
  const walletName = useWalletNames();
  const [form, setForm] = useState({ seller: "", buyer: "", quantity: "", price: "" });
  const [fund, setFund] = useState({ wallet: "", amount: "100000" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAct = perspective === "requester";
  const selected = trades?.find((trade) => trade.id === openId);

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
  const settled = (id: string) =>
    waitUntil(
      () => call<Trade>(`/trades/${id}`),
      (trade) => trade.status !== "PENDING" && trade.status !== "CANCELLING",
    );

  const columns: Column<Trade>[] = [
    { header: "체결번호", cell: (row) => <Mono>{row.tradeNo}</Mono> },
    { header: "매도", cell: (row) => walletName(row.seller) },
    { header: "매수", cell: (row) => walletName(row.buyer) },
    { header: "수량", cell: (row) => units(row.quantity), numeric: true },
    { header: "대금(USDC)", cell: (row) => cash(row.price), numeric: true },
    { header: "상태", cell: (row) => <StatusBadge status={row.status} /> },
    { header: "시도", cell: (row) => `${row.settleAttempts}회`, numeric: true },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <b>DvP(증권과 대금의 동시 결제).</b> 체결이 접수되면 ① 매도자·매수자가 체결 조건에 서명하고 ② 각자 자기 몫(증권, 대금)을 결제 컨트랙트가 가져가도록 승인한 뒤
        ③ 한 트랜잭션 안에서 증권과 대금이 맞교환됩니다. 어느 한쪽이라도 실패하면 둘 다 일어나지 않습니다. 실패한 체결은 원인을 해결한 뒤 재시도하거나 취소할 수
        있습니다.
      </Notice>
      <div className="grid gap-3 md:grid-cols-2">
        <Panel title="체결 접수 (모의 장외거래소)">
          <form
            className="grid gap-2 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void guard(async () => {
                const created = await call<Trade>("/otc/trades", { body: { seller: form.seller, buyer: form.buyer, quantity: form.quantity, price: toCashUnits(form.price) } });
                setOpenId(created.id);
                await settled(created.id);
              });
            }}
          >
            <Field label="매도자">
              <WalletSelect value={form.seller} onChange={(seller) => setForm({ ...form, seller })} />
            </Field>
            <Field label="매수자">
              <WalletSelect value={form.buyer} onChange={(buyer) => setForm({ ...form, buyer })} />
            </Field>
            <Field label="수량">
              <Input inputMode="numeric" pattern="[1-9][0-9]*" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required />
            </Field>
            <Field label="총 대금 (USDC)">
              <Input inputMode="numeric" pattern="[0-9]+" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} required />
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={!canAct || busy || !form.seller || !form.buyer || form.seller === form.buyer || !form.quantity || !form.price}>
                체결 접수 후 결제
              </Button>
            </div>
          </form>
        </Panel>
        <Panel title="테스트 현금 지급">
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void guard(async () => {
                const { outboxId } = await call<{ outboxId: string }>(`/wallets/${fund.wallet}/cash`, { body: { amount: toCashUnits(fund.amount) } });
                await waitForTransaction(outboxId);
              });
            }}
          >
            <p className="text-[12px] text-mute">매수자가 대금을 치르려면 현금 토큰(테스트용 USDC)이 있어야 합니다. 데모에서는 여기서 지급합니다.</p>
            <Field label="받는 지갑">
              <WalletSelect value={fund.wallet} onChange={(wallet) => setFund({ ...fund, wallet })} />
            </Field>
            <Field label="금액 (USDC)">
              <Input inputMode="numeric" pattern="[1-9][0-9]*" value={fund.amount} onChange={(event) => setFund({ ...fund, amount: event.target.value })} required />
            </Field>
            <Button type="submit" variant="ghost" disabled={!canAct || busy || !fund.wallet}>
              지급
            </Button>
          </form>
        </Panel>
      </div>
      {!canAct && <Notice>체결 접수는 “요청 담당자” 관점에서 할 수 있습니다.</Notice>}
      {busy && <Notice>체인에 반영되기를 기다리는 중입니다…</Notice>}
      {error && <p className="text-no">{error}</p>}
      <Panel title="체결 목록">
        <Table columns={columns} rows={trades} rowKey={(row) => row.id} onRowClick={(row) => setOpenId(openId === row.id ? null : row.id)} selectedKey={openId ?? undefined} empty="접수된 체결이 없습니다." />
        {selected && (
          <div className="mt-2 space-y-2 border border-line bg-canvas p-2 text-[12px]">
            <p className="text-mute">
              온체인 거래 식별자 <Mono>{selected.tradeId}</Mono> · 접수 {dateTime(selected.createdAt)} · 유효 기한 {dateTime(selected.expiry)}
            </p>
            {selected.txHash && (
              <p className="text-mute">
                결제 트랜잭션 <Mono>{selected.txHash}</Mono>
              </p>
            )}
            {selected.failure && <Rejection code={selected.failure.errorCode} detail={`${selected.failure.step}: ${selected.failure.errorMessage ?? ""}`} />}
            {selected.status === "FAILED" && canAct && (
              <span className="flex gap-1">
                {selected.failure?.step === "settle" && (
                  <Button disabled={busy} onClick={() => guard(async () => void (await call(`/trades/${selected.id}/retry`, { method: "POST" }), await settled(selected.id)))}>
                    재시도
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => guard(async () => void (await call(`/trades/${selected.id}/cancel`, { body: { reasonCode: "OPERATOR_CANCEL" } }), await settled(selected.id)))}
                >
                  취소
                </Button>
              </span>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
