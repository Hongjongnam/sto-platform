"use client";

import { useState } from "react";
import type { ChainEvent, Portfolio, Transaction } from "../../lib/api";
import { cash, EVENT_LABELS, units } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { useEventSummary, WalletSelect } from "../../components/domain";
import { Badge, Button, type Column, Field, Input, Notice, Panel, Rejection, Stat, Table } from "../../components/ui";

export default function WalletPage() {
  const { call } = useSession();
  const { waitForTransaction } = useChainActions();
  const summary = useEventSummary();
  const [wallet, setWallet] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: portfolio } = useApiQuery<Portfolio>(`/wallets/${wallet}/portfolio`, { enabled: !!wallet });
  const { data: events } = useApiQuery<ChainEvent[]>(`/events?address=${wallet}&limit=30`, { enabled: !!wallet });

  const transfer = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { transactionId } = await call<{ transactionId: string }>(`/wallets/${wallet}/transfers`, { body: { to, amount } });
      setResult(await waitForTransaction(transactionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ChainEvent>[] = [
    { header: "블록", cell: (row) => units(row.blockNumber), numeric: true, width: "70px" },
    { header: "이벤트", cell: (row) => EVENT_LABELS[row.name] ?? row.name },
    { header: "내용", cell: summary },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <b>투자자 관점.</b> 투자자는 자기 계좌의 잔고를 보고, 다른 투자자에게 전송하고, 배당·상환을 청구합니다. 이 데모는 증권사가 고객 지갑을 대신 보관하는
        방식(수탁형)이라, 투자자의 요청을 받아 그 지갑의 키로 서명합니다. 전송은 컨트랙트의 검사를 그대로 받으므로, 신원이 확인되지 않은 상대나 동결된 수량으로는
        보낼 수 없습니다.
      </Notice>
      <Panel title="계좌 선택">
        <WalletSelect value={wallet} onChange={setWallet} placeholder="투자자 지갑을 고르세요" />
      </Panel>
      {wallet && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="보유 수량" value={units(portfolio?.balance)} />
            <Stat label="거래 가능 수량" value={units(portfolio?.free)} sub={portfolio && portfolio.frozen !== "0" ? `동결 ${units(portfolio.frozen)}` : "동결 없음"} />
            <Stat label="현금 (USDC)" value={cash(portfolio?.cash)} />
            <Stat
              label="계좌 상태"
              value={
                portfolio ? (
                  <span className="flex flex-wrap gap-1 text-[12px]">
                    <Badge tone={portfolio.verified ? "good" : "bad"}>{portfolio.verified ? "신원 유효" : "신원 무효"}</Badge>
                    {portfolio.addressFrozen && <Badge tone="bad">계좌 동결</Badge>}
                  </span>
                ) : (
                  "-"
                )
              }
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-[2fr_3fr]">
            <Panel title="전송">
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void transfer();
                }}
              >
                <Field label="받는 사람">
                  <WalletSelect value={to} onChange={setTo} />
                </Field>
                <Field label="수량">
                  <Input inputMode="numeric" pattern="[1-9][0-9]*" value={amount} onChange={(event) => setAmount(event.target.value)} required />
                </Field>
                <Button type="submit" disabled={busy || !to || !amount || to === wallet}>
                  {busy ? "체인에 보내는 중…" : "전송"}
                </Button>
              </form>
              <div className="mt-2 space-y-2">
                {result?.status === "CONFIRMED" && <p className="font-semibold text-ok">전송되었습니다. (블록 {result.blockNumber})</p>}
                {result?.status === "FAILED" && <Rejection code={result.errorCode} detail={result.errorMessage} />}
                {error && <p className="text-no">{error}</p>}
              </div>
            </Panel>
            <Panel title="이 계좌의 기록">
              <Table columns={columns} rows={events} rowKey={(row) => String(row.id)} empty="아직 기록이 없습니다." />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
