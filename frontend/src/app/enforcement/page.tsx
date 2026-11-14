"use client";

import { useState } from "react";
import type { Operation } from "../../lib/api";
import { OPERATION_LABELS } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { evidenceHash, OperationsTable, ReasonSelect, WalletSelect } from "../../components/domain";
import { Button, Field, Input, Notice, Panel, Select } from "../../components/ui";

const TYPES = ["FREEZE_PARTIAL", "UNFREEZE_PARTIAL", "FREEZE_ADDRESS", "UNFREEZE_ADDRESS", "FORCED_TRANSFER", "RECOVERY", "PAUSE", "UNPAUSE"];
const NEEDS_AMOUNT = ["FREEZE_PARTIAL", "UNFREEZE_PARTIAL", "FORCED_TRANSFER"];
const NEEDS_SECOND_WALLET = ["FORCED_TRANSFER", "RECOVERY"];
const NO_WALLET = ["PAUSE", "UNPAUSE"];

const HELP: Record<string, string> = {
  FREEZE_PARTIAL: "보유 수량 중 일부만 묶습니다. 나머지는 계속 거래할 수 있습니다.",
  UNFREEZE_PARTIAL: "묶어 둔 수량을 풉니다.",
  FREEZE_ADDRESS: "계좌 전체를 묶습니다. 보내는 것도 받는 것도 할 수 없게 됩니다.",
  UNFREEZE_ADDRESS: "계좌 동결을 풉니다.",
  FORCED_TRANSFER: "보유자의 동의 없이 수량을 옮깁니다. 받는 쪽은 반드시 신원이 확인된 지갑이어야 합니다. 동결된 수량은 필요한 만큼만 풀립니다.",
  RECOVERY: "키를 분실한 지갑의 전체 잔고를 같은 투자자의 새 지갑으로 옮깁니다. 동결 상태도 함께 옮겨집니다.",
  PAUSE: "모든 일반 전송·발행·소각을 멈춥니다. 강제이전과 동결은 정지 중에도 가능합니다. 승인 없이 즉시 실행됩니다.",
  UNPAUSE: "거래를 재개합니다. 승인 없이 즉시 실행됩니다.",
};

export default function EnforcementPage() {
  const { call, perspective } = useSession();
  const { waitForOperation, refresh } = useChainActions();
  const { data: operations } = useApiQuery<Operation[]>("/operations");
  const [type, setType] = useState("FREEZE_PARTIAL");
  const [wallet, setWallet] = useState("");
  const [second, setSecond] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("COURT_ORDER");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const params = (): Record<string, string> => {
    if (NO_WALLET.includes(type)) return {};
    if (type === "FORCED_TRANSFER") return { from: wallet, to: second, amount };
    if (type === "RECOVERY") return { lostWallet: wallet, newWallet: second };
    if (NEEDS_AMOUNT.includes(type)) return { account: wallet, amount };
    return { account: wallet };
  };

  const file = () =>
    guard(async () => {
      const immediate = NO_WALLET.includes(type);
      const created = await call<Operation>("/operations", {
        body: {
          type,
          params: params(),
          reasonCode: immediate ? "MAINTENANCE" : reason,
          ...(immediate ? {} : { evidenceHash: await evidenceHash(evidence) }),
        },
      });
      if (immediate) await waitForOperation(created.id);
      else await refresh();
    });

  const decide = (operation: Operation, decision: "approve" | "reject") =>
    guard(async () => {
      await call<Operation>(`/operations/${operation.id}/${decision}`, { body: decision === "reject" ? { note: "요건 미충족" } : { note: "근거 문서 확인" } });
      if (decision === "approve") await waitForOperation(operation.id);
      else await refresh();
    });

  const enforcement = operations?.filter((operation) => TYPES.includes(operation.type) || operation.type === "SET_REGISTERED_SUPPLY");
  const pending = enforcement?.filter((operation) => operation.status === "PENDING_APPROVAL");
  const complete =
    NO_WALLET.includes(type) ||
    (wallet && evidence.trim() && (!NEEDS_AMOUNT.includes(type) || amount) && (!NEEDS_SECOND_WALLET.includes(type) || second));

  return (
    <div className="space-y-3">
      <Notice>
        <b>두 사람 원칙.</b> 보유자의 뜻과 무관하게 자산을 묶거나 옮기는 작업은 한 사람이 혼자 실행할 수 없습니다. 요청한 담당자와 <b>다른</b> 담당자가 승인해야
        체인으로 전송되고, 근거 문서(법원 명령서 등)의 해시가 함께 기록됩니다. 화면 위의 관점을 바꿔 가며 요청과 승인을 각각 해 보세요.
      </Notice>
      <div className="grid gap-3 lg:grid-cols-[2fr_3fr]">
        <Panel title="집행 요청">
          {perspective === "requester" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void file();
              }}
            >
              <Field label="작업" hint={HELP[type]}>
                <Select value={type} onChange={(event) => setType(event.target.value)}>
                  {TYPES.map((value) => (
                    <option key={value} value={value}>
                      {OPERATION_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              {!NO_WALLET.includes(type) && (
                <Field label={type === "RECOVERY" ? "분실한 지갑" : type === "FORCED_TRANSFER" ? "보내는 지갑" : "대상 지갑"}>
                  <WalletSelect value={wallet} onChange={setWallet} />
                </Field>
              )}
              {NEEDS_SECOND_WALLET.includes(type) && (
                <Field label={type === "RECOVERY" ? "새 지갑 (같은 투자자의 지갑)" : "받는 지갑"}>
                  <WalletSelect value={second} onChange={setSecond} />
                </Field>
              )}
              {NEEDS_AMOUNT.includes(type) && (
                <Field label="수량">
                  <Input inputMode="numeric" pattern="[1-9][0-9]*" value={amount} onChange={(event) => setAmount(event.target.value)} required />
                </Field>
              )}
              {!NO_WALLET.includes(type) && (
                <>
                  <Field label="사유">
                    <ReasonSelect value={reason} onChange={setReason} options={["COURT_ORDER", "REGULATORY_HOLD", "INHERITANCE", "LOST_KEY"]} />
                  </Field>
                  <Field label="근거 문서" hint="문서 이름이나 번호를 적으면 그 해시가 요청에 기록됩니다">
                    <Input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="예: 서울중앙지법 2027카합1234 결정문" />
                  </Field>
                </>
              )}
              <Button type="submit" disabled={busy || !complete}>
                {NO_WALLET.includes(type) ? "즉시 실행" : "요청 올리기"}
              </Button>
            </form>
          ) : (
            <Notice>요청은 “요청 담당자” 관점에서 올립니다. 지금 관점에서는 오른쪽 대기열의 요청을 승인하거나 반려할 수 있습니다.</Notice>
          )}
          {error && <p className="mt-2 text-no">{error}</p>}
        </Panel>
        <Panel title={`승인 대기열 ${pending ? `(${pending.length})` : ""}`}>
          <OperationsTable
            operations={pending}
            actions={(operation) =>
              perspective === "approver" ? (
                <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                  <Button disabled={busy} onClick={() => decide(operation, "approve")}>
                    승인
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => decide(operation, "reject")}>
                    반려
                  </Button>
                </span>
              ) : (
                <span className="text-[11px] text-mute">승인 담당자만 결정</span>
              )
            }
          />
        </Panel>
      </div>
      {busy && <Notice>체인에 반영되기를 기다리는 중입니다…</Notice>}
      <Panel title="집행 내역">
        <OperationsTable operations={enforcement?.filter((operation) => operation.status !== "PENDING_APPROVAL")} />
      </Panel>
    </div>
  );
}
