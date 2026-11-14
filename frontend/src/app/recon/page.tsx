"use client";

import { useState } from "react";
import type { ReconReport } from "../../lib/api";
import { dateTime, shortAddress, units } from "../../lib/format";
import { useApiQuery, useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Button, type Column, Mono, Notice, Panel, Table } from "../../components/ui";

const FIELD_LABELS: Record<string, string> = {
  balance: "지갑 잔고",
  frozen: "동결 수량",
  addressFrozen: "계좌 동결 여부",
  totalSupply: "발행 총량",
  registeredSupply: "등록 총량",
  paused: "거래 정지 여부",
  sumOfBalances: "잔고 합계",
  investorBalance: "투자자별 합산 잔고",
  holderCount: "보유자 수",
};
type Mismatch = ReconReport["mismatches"][number];

export default function ReconPage() {
  const { call, perspective } = useSession();
  const { refresh } = useChainActions();
  const { data: reports } = useApiQuery<ReconReport[]>("/recon/reports");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = reports?.find((report) => report.id === openId) ?? reports?.[0];

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ReconReport>[] = [
    { header: "실행 시각", cell: (row) => dateTime(row.createdAt) },
    { header: "기준 블록", cell: (row) => units(row.blockNumber), numeric: true },
    { header: "검사 지갑", cell: (row) => `${row.walletsChecked}개`, numeric: true },
    { header: "결과", cell: (row) => (row.ok ? <b className="text-ok">일치</b> : <b className="text-no">불일치 {row.mismatches.length}건</b>) },
  ];
  const mismatchColumns: Column<Mismatch>[] = [
    { header: "항목", cell: (row) => FIELD_LABELS[row.field] ?? row.field },
    { header: "대상", cell: (row) => (row.subject ? <Mono>{row.subject.length === 42 ? shortAddress(row.subject) : `${row.subject.slice(0, 12)}…`}</Mono> : "토큰 전체") },
    { header: "내부 장부", cell: (row) => <span className="text-no">{row.ledger}</span>, numeric: true },
    { header: "블록체인", cell: (row) => <b>{row.chain}</b>, numeric: true },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <b>대사(對査)란?</b> 회사가 내부 데이터베이스에 관리하는 장부와 블록체인의 실제 기록이 같은지 맞춰 보는 일입니다. 토큰증권에서는 <b>블록체인이 원본</b>이므로,
        어긋나면 고치는 쪽은 언제나 내부 장부입니다. 이 화면에서는 ① 대사를 실행하고 ② 일부러 장부를 틀리게 만든 뒤 ③ 대사가 그것을 찾아내는지 보고 ④ 체인
        이벤트를 다시 재생해 장부를 복구해 볼 수 있습니다.
      </Notice>
      <Panel title="실행">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => act(async () => ((await call<ReconReport>("/recon/run", { method: "POST" })).ok ? "대사 결과: 일치합니다." : "대사 결과: 불일치가 발견되었습니다. 아래 보고서를 확인하세요."))}>
            ① 대사 실행
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const result = await call<{ wallet: string; addedToLedger: string }>("/demo/ledger/corrupt", { method: "POST" });
                return `내부 장부에서 ${shortAddress(result.wallet)} 지갑의 잔고를 ${result.addedToLedger}만큼 부풀렸습니다. 체인은 그대로입니다. 대사를 다시 실행해 보세요.`;
              })
            }
          >
            ② 장부 일부러 틀리게 만들기
          </Button>
          <Button
            variant="ghost"
            disabled={busy || perspective !== "approver"}
            title={perspective === "approver" ? "" : "승인 담당자 관점에서만 실행할 수 있습니다"}
            onClick={() => act(async () => `체인 이벤트 ${(await call<{ events: number }>("/recon/rebuild", { method: "POST" })).events}건을 다시 재생해 장부를 복구했습니다. 대사를 다시 실행해 보세요.`)}
          >
            ③ 장부 복구 (이벤트 재생)
          </Button>
          {perspective !== "approver" && <span className="text-[11px] text-mute">복구는 “승인 담당자” 관점에서 실행합니다.</span>}
        </div>
        {message && <p className="mt-2 text-[12px] font-semibold text-navy">{message}</p>}
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="대사 보고서">
          <Table columns={columns} rows={reports} rowKey={(row) => row.id} onRowClick={(row) => setOpenId(row.id)} selectedKey={selected?.id} empty="아직 대사를 실행하지 않았습니다." />
        </Panel>
        <Panel title={selected ? `불일치 내역 · 블록 ${units(selected.blockNumber)}` : "불일치 내역"}>
          {selected?.ok ? (
            <p className="py-6 text-center font-semibold text-ok">내부 장부와 블록체인이 모든 항목에서 일치합니다.</p>
          ) : (
            <Table columns={mismatchColumns} rows={selected?.mismatches} rowKey={(row) => `${row.field}-${row.subject ?? ""}`} empty="보고서를 선택하세요." />
          )}
        </Panel>
      </div>
    </div>
  );
}
