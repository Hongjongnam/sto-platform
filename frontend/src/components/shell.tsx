"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import type { LedgerState } from "../lib/api";
import { units } from "../lib/format";
import { useApiQuery } from "../lib/hooks";
import { type Perspective, useSession } from "../lib/session";
import { Badge, Button, Notice } from "./ui";

const OPERATOR_NAV = [
  { href: "/guide", label: "안내 시나리오" },
  { href: "/dashboard", label: "대시보드" },
  { href: "/investors", label: "투자자" },
  { href: "/issuance", label: "발행·소각" },
  { href: "/enforcement", label: "집행·승인" },
  { href: "/trades", label: "체결·결제" },
  { href: "/corporate", label: "권리(배당·상환)" },
  { href: "/audit", label: "감사 로그" },
  { href: "/recon", label: "대사" },
];
const INVESTOR_NAV = [
  { href: "/guide", label: "안내 시나리오" },
  { href: "/wallet", label: "내 계좌" },
];

const PERSPECTIVES: { key: Perspective; label: string; hint: string }[] = [
  { key: "requester", label: "요청 담당자", hint: "투자자 등록과 각종 작업을 요청합니다" },
  { key: "approver", label: "승인 담당자", hint: "다른 사람이 올린 요청을 승인하거나 반려합니다" },
  { key: "investor", label: "투자자", hint: "자기 계좌에서 전송하고 권리를 청구합니다" },
];

export function Shell({ children }: { children: ReactNode }) {
  const { ready, session } = useSession();
  if (!ready) return <div className="p-8 text-center text-mute">불러오는 중…</div>;
  if (!session) return <Entry />;
  return <Console>{children}</Console>;
}

function Console({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { perspective, setPerspective, leave } = useSession();
  const { data: state } = useApiQuery<LedgerState>("/ledger/state");
  const nav = perspective === "investor" ? INVESTOR_NAV : OPERATOR_NAV;
  const current = PERSPECTIVES.find((item) => item.key === perspective)!;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-navy text-white">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <Link href="/guide" className="flex items-center gap-2">
            <span className="text-[15px] font-extrabold tracking-tight">토큰증권 운영 콘솔</span>
            <span className="bg-accent px-1.5 py-px text-[10px] font-bold">DEMO</span>
          </Link>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] text-white/70">관점</span>
            {PERSPECTIVES.map((item) => (
              <button
                key={item.key}
                onClick={() => setPerspective(item.key)}
                title={item.hint}
                className={`px-2 py-1 text-[12px] font-semibold ${perspective === item.key ? "bg-white text-navy" : "bg-white/10 text-white hover:bg-white/20"}`}
              >
                {item.label}
              </button>
            ))}
            <button onClick={leave} className="ml-2 px-2 py-1 text-[11px] text-white/70 hover:text-white">
              나가기
            </button>
          </div>
        </div>
        <nav className="flex gap-px overflow-x-auto bg-navy-deep px-2">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap px-3 py-2 text-[12px] font-semibold ${pathname === item.href ? "bg-canvas text-navy" : "text-white/80 hover:bg-white/10"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-white px-3 py-1.5 text-[11px] text-mute">
        <span>
          현재 관점 <b className="text-ink">{current.label}</b> · {current.hint}
        </span>
        {state && (
          <span className="ml-auto flex flex-wrap gap-x-4">
            <span>
              발행 총량 <b className="num text-ink">{units(state.totalSupply)}</b> / 등록 {units(state.registeredSupply)}
            </span>
            <span>
              보유자 <b className="text-ink">{state.holders}</b>명
            </span>
            <span>
              반영 블록 <b className="text-ink">{units(state.indexedBlock)}</b>
              {state.chainBlock - state.indexedBlock > 3 && <span className="text-no"> (체인보다 {state.chainBlock - state.indexedBlock}블록 뒤)</span>}
            </span>
            {state.paused && <Badge tone="bad">거래 정지 중</Badge>}
          </span>
        )}
      </div>

      <main className="mx-auto w-full max-w-[1400px] flex-1 p-3">{children}</main>

      <footer className="border-t border-line bg-white px-3 py-2 text-center text-[11px] text-mute">
        데모 환경입니다. 실제 증권이나 자금이 아니며, 표시되는 투자자는 모두 가상의 인물입니다. 데이터는 주기적으로 초기화됩니다.
      </footer>
    </div>
  );
}

function Entry() {
  const { enter } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await enter();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-navy px-4 py-10">
      <div className="w-full max-w-[680px] bg-white p-6 md:p-8">
        <p className="text-[11px] font-bold tracking-widest text-accent">SECURITY TOKEN · DEMO</p>
        <h1 className="mt-1 text-[24px] font-extrabold text-navy">토큰증권 운영 콘솔</h1>
        <p className="mt-3 text-[13px] leading-relaxed">
          증권을 블록체인 토큰으로 발행하고, 거래를 결제하고, 배당을 지급하는 과정을 직접 눌러 보며 따라가는 데모입니다. 일반 토큰과 달리
          증권 토큰은 <b>누가 보유할 수 있는지</b>, <b>언제 강제로 옮길 수 있는지</b>, <b>회사 장부와 어떻게 맞추는지</b>가 핵심입니다.
        </p>
        <ul className="mt-4 grid gap-2 text-[12px] md:grid-cols-2">
          {[
            ["신원 확인된 투자자만 보유", "KYC를 통과하지 않은 지갑으로는 발행도 전송도 되지 않습니다"],
            ["동결과 강제이전", "법원 명령 같은 사유로 계좌를 묶거나 자산을 옮깁니다. 반드시 두 사람이 관여합니다"],
            ["증권과 대금의 동시 결제", "한쪽이라도 실패하면 둘 다 일어나지 않습니다"],
            ["장부 대사", "회사 내부 장부와 블록체인이 일치하는지 비교하고, 어긋나면 복구합니다"],
          ].map(([title, body]) => (
            <li key={title} className="border border-line p-2">
              <p className="font-bold text-navy">{title}</p>
              <p className="mt-0.5 text-mute">{body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="danger" onClick={start} disabled={busy} className="px-5 py-2.5 text-[14px]">
            {busy ? "입장하는 중…" : "데모로 입장"}
          </Button>
          <span className="text-[11px] text-mute">가입이 필요 없습니다. 입장 후 화면 위에서 관점(요청 담당자 · 승인 담당자 · 투자자)을 바꿀 수 있습니다.</span>
        </div>
        {error && (
          <div className="mt-4">
            <Notice tone="warn">
              서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요. <span className="text-mute">({error})</span>
            </Notice>
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-[11px] text-white/60">데모 환경입니다. 실제 증권이나 자금이 아니며, 특정 금융회사와 관련이 없습니다.</p>
    </div>
  );
}
