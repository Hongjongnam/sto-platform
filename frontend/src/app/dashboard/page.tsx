"use client";

import type { ChainEvent, Holding, LedgerState, ReconReport } from "../../lib/api";
import { dateTime, EVENT_LABELS, shortAddress, units } from "../../lib/format";
import { useApiQuery } from "../../lib/hooks";
import { Badge, type Column, Mono, Panel, Stat, Table } from "../../components/ui";

export default function DashboardPage() {
  const { data: state } = useApiQuery<LedgerState>("/ledger/state");
  const { data: holdings } = useApiQuery<Holding[]>("/ledger/holdings");
  const { data: events } = useApiQuery<ChainEvent[]>("/events?limit=12");
  const { data: reports } = useApiQuery<ReconReport[]>("/recon/reports");
  const lastReport = reports?.[0];

  const holdingColumns: Column<Holding>[] = [
    { header: "투자자", cell: (row) => row.investorName ?? "-" },
    { header: "지갑", cell: (row) => <Mono>{shortAddress(row.wallet)}</Mono> },
    { header: "보유", cell: (row) => units(row.balance), numeric: true },
    { header: "동결", cell: (row) => (row.frozen === "0" ? "-" : <span className="text-no">{units(row.frozen)}</span>), numeric: true },
    { header: "상태", cell: (row) => (row.addressFrozen ? <Badge tone="bad">계좌 동결</Badge> : <Badge tone="good">정상</Badge>) },
  ];
  const eventColumns: Column<ChainEvent>[] = [
    { header: "블록", cell: (row) => units(row.blockNumber), numeric: true, width: "70px" },
    { header: "이벤트", cell: (row) => EVENT_LABELS[row.name] ?? row.name },
    { header: "컨트랙트", cell: (row) => <span className="text-mute">{row.contract}</span> },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="발행 총량" value={state ? units(state.totalSupply) : "-"} sub={state ? `등록 총량 ${units(state.registeredSupply)}` : undefined} />
        <Stat label="보유 투자자" value={state ? `${state.holders}명` : "-"} sub="지갑 수가 아니라 투자자 수" />
        <Stat
          label="장부 반영 블록"
          value={state ? units(state.indexedBlock) : "-"}
          sub={state ? `체인 최신 블록 ${units(state.chainBlock)}` : undefined}
        />
        <Stat
          label="마지막 대사"
          value={lastReport ? (lastReport.ok ? <span className="text-ok">일치</span> : <span className="text-no">불일치 {lastReport.mismatches.length}건</span>) : "미실행"}
          sub={lastReport ? dateTime(lastReport.createdAt) : "대사 메뉴에서 실행"}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <Panel title="보유 현황 (내부 장부)">
          <Table columns={holdingColumns} rows={holdings?.filter((row) => row.balance !== "0" || row.addressFrozen)} rowKey={(row) => row.wallet} empty="아직 발행된 수량이 없습니다. 안내 시나리오를 먼저 진행해 보세요." />
        </Panel>
        <Panel title="최근 체인 이벤트">
          <Table columns={eventColumns} rows={events} rowKey={(row) => String(row.id)} empty="아직 이벤트가 없습니다." />
        </Panel>
      </div>
    </div>
  );
}
