"use client";

import { useState } from "react";
import type { LedgerState, Operation } from "../../lib/api";
import { units } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { evidenceHash, OperationsTable, ReasonSelect, WalletSelect } from "../../components/domain";
import { Button, Field, Input, Notice, Panel } from "../../components/ui";

const TYPES = ["MINT", "BURN", "SET_REGISTERED_SUPPLY"];

export default function IssuancePage() {
  const { call, perspective } = useSession();
  const { waitForOperation } = useChainActions();
  const { data: operations } = useApiQuery<Operation[]>("/operations");
  const { data: state } = useApiQuery<LedgerState>("/ledger/state");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState({ to: "", amount: "", reason: "PRIMARY_ISSUANCE" });
  const [burn, setBurn] = useState({ from: "", amount: "", reason: "CAPITAL_REDUCTION" });
  const [supply, setSupply] = useState("");
  const canAct = perspective === "requester";

  const submit = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      const created = await call<Operation>("/operations", { body });
      await waitForOperation(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {!canAct && <Notice>발행·소각 요청은 “요청 담당자” 관점에서 할 수 있습니다.</Notice>}
      <div className="grid gap-3 md:grid-cols-3">
        <Panel title="발행">
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ type: "MINT", params: { to: mint.to, amount: mint.amount }, reasonCode: mint.reason });
            }}
          >
            <Field label="받는 지갑">
              <WalletSelect value={mint.to} onChange={(to) => setMint({ ...mint, to })} />
            </Field>
            <Field label="수량">
              <Input inputMode="numeric" pattern="[1-9][0-9]*" value={mint.amount} onChange={(event) => setMint({ ...mint, amount: event.target.value })} required />
            </Field>
            <Field label="사유">
              <ReasonSelect value={mint.reason} onChange={(reason) => setMint({ ...mint, reason })} options={["PRIMARY_ISSUANCE", "ADDITIONAL_ISSUANCE"]} />
            </Field>
            <Button type="submit" disabled={!canAct || busy || !mint.to || !mint.amount}>
              발행 요청
            </Button>
          </form>
        </Panel>
        <Panel title="소각">
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ type: "BURN", params: { from: burn.from, amount: burn.amount }, reasonCode: burn.reason });
            }}
          >
            <Field label="대상 지갑">
              <WalletSelect value={burn.from} onChange={(from) => setBurn({ ...burn, from })} />
            </Field>
            <Field label="수량" hint="동결된 수량과 동결된 계좌의 수량은 소각할 수 없습니다">
              <Input inputMode="numeric" pattern="[1-9][0-9]*" value={burn.amount} onChange={(event) => setBurn({ ...burn, amount: event.target.value })} required />
            </Field>
            <Field label="사유">
              <ReasonSelect value={burn.reason} onChange={(reason) => setBurn({ ...burn, reason })} options={["CAPITAL_REDUCTION"]} />
            </Field>
            <Button type="submit" disabled={!canAct || busy || !burn.from || !burn.amount}>
              소각 요청
            </Button>
          </form>
        </Panel>
        <Panel title="등록 총량 변경">
          <form
            className="space-y-2"
            onSubmit={async (event) => {
              event.preventDefault();
              await submit({
                type: "SET_REGISTERED_SUPPLY",
                params: { amount: supply },
                reasonCode: "REGISTRATION",
                evidenceHash: await evidenceHash(`registration:${supply}`),
              });
            }}
          >
            <p className="text-[12px]">
              현재 등록 총량 <b className="num">{state ? units(state.registeredSupply) : "-"}</b> · 발행 총량 <b className="num">{state ? units(state.totalSupply) : "-"}</b>
            </p>
            <Field label="새 등록 총량" hint="다른 담당자의 승인이 필요합니다">
              <Input inputMode="numeric" pattern="[0-9]+" value={supply} onChange={(event) => setSupply(event.target.value)} required />
            </Field>
            <Button type="submit" disabled={!canAct || busy || !supply}>
              변경 요청
            </Button>
          </form>
        </Panel>
      </div>
      {busy && <Notice>체인에 반영되기를 기다리는 중입니다…</Notice>}
      {error && <p className="text-no">{error}</p>}
      <Notice>
        <b>등록 총량이란?</b> 증권은 전자등록된 수량만큼만 존재할 수 있습니다. 이 시스템에서는 등록 담당 역할이 등록 총량을 정해 두고, 그보다 많이 발행하려 하면
        컨트랙트가 거부합니다. 발행은 신원이 확인된 지갑으로만 가능하고, 투자자별 보유 한도 같은 규칙도 함께 검사됩니다. 아래 목록에서 줄을 누르면 거부 사유를 볼 수
        있습니다.
      </Notice>
      <Panel title="발행·소각·등록 총량 요청 내역">
        <OperationsTable operations={operations?.filter((operation) => TYPES.includes(operation.type))} />
      </Panel>
    </div>
  );
}
