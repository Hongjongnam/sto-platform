"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { type Cast, explain, type Line, STEPS } from "../../lib/scenario";
import { useChainActions } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Button, Mono, Notice, Panel } from "../../components/ui";

type StepState = { status: "idle" | "running" | "done" | "error"; lines: Line[]; error?: string };

interface Progress {
  states: StepState[];
  cast: Partial<Cast>;
}

const PROGRESS_KEY = "sto-demo-guide";
const emptyStates = (): StepState[] => STEPS.map(() => ({ status: "idle", lines: [] }));

function loadProgress(): Progress {
  try {
    const raw = window.sessionStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Progress;
      if (parsed.states.length === STEPS.length) {
        // A step that was running when the page was left did not finish here.
        return { cast: parsed.cast, states: parsed.states.map((state) => (state.status === "running" ? { status: "idle", lines: [] } : state)) };
      }
    }
  } catch {
    // Storage unavailable or unreadable: start from the beginning.
  }
  return { states: emptyStates(), cast: {} };
}

function saveProgress(progress: Progress): void {
  try {
    window.sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage unavailable: progress lasts until the page is left.
  }
}

const AFTER: { href: string; label: string; body: string }[] = [
  { href: "/audit", label: "감사 로그", body: "방금 한 모든 작업이 누가, 왜 했는지와 함께 체인에 남은 기록" },
  { href: "/dashboard", label: "대시보드", body: "발행 총량, 보유 현황, 최근 이벤트" },
  { href: "/enforcement", label: "집행·승인", body: "관점을 바꿔 가며 요청과 승인을 직접 해 보기" },
  { href: "/wallet", label: "내 계좌", body: "투자자 관점에서 잔고 확인과 전송" },
];

export default function GuidePage() {
  const { call } = useSession();
  const chain = useChainActions();
  // Progress is kept for the browser session, so visiting another screen and coming back
  // does not lose the steps already run or the investors they created.
  const [saved] = useState(loadProgress);
  const cast = useRef<Partial<Cast>>(saved.cast);
  const [states, setStates] = useState<StepState[]>(saved.states);
  const update = (index: number, next: StepState) =>
    setStates((current) => {
      const updated = current.map((state, i) => (i === index ? next : state));
      saveProgress({ states: updated, cast: cast.current });
      return updated;
    });
  const running = states.some((state) => state.status === "running");
  const nextIndex = states.findIndex((state) => state.status !== "done");

  const run = async (index: number) => {
    update(index, { status: "running", lines: [] });
    try {
      const lines = await STEPS[index].run({ call, ...chain }, cast.current);
      update(index, { status: "done", lines });
    } catch (cause) {
      update(index, { status: "error", lines: [], error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const restart = () => {
    cast.current = {};
    const fresh = emptyStates();
    saveProgress({ states: fresh, cast: {} });
    setStates(fresh);
  };

  return (
    <div className="mx-auto max-w-[980px] space-y-3">
      <Panel title="안내 시나리오">
        <p className="text-[13px] leading-relaxed">
          증권 토큰의 한 생애를 아홉 단계로 따라갑니다. 각 단계의 <b>실행</b>을 누르면 실제로 블록체인에 트랜잭션이 전송되고, 그 결과가 아래에 표시됩니다. 단계마다
          일부러 규칙을 어기는 시도가 들어 있어, 컨트랙트가 무엇을 <span className="font-bold text-no">막는지</span>와 그 이유를 함께 볼 수 있습니다.
        </p>
        <p className="mt-2 text-[12px] text-mute">
          한 단계는 몇 초에서 십몇 초가 걸립니다. 블록이 1초마다 만들어지고, 단계마다 트랜잭션이 여러 건 차례로 확정되기를 기다리기 때문입니다.
        </p>
      </Panel>

      {STEPS.map((step, index) => {
        const state = states[index];
        const available = index === nextIndex || state.status === "error";
        return (
          <section key={step.title} className={`border bg-panel ${index === nextIndex ? "border-navy" : "border-line"}`}>
            <header className="flex flex-wrap items-center gap-2 border-b border-line bg-head px-3 py-2">
              <span className={`flex h-6 w-6 items-center justify-center text-[12px] font-bold text-white ${state.status === "done" ? "bg-ok" : "bg-navy"}`}>
                {state.status === "done" ? "✓" : index + 1}
              </span>
              <h2 className="text-[14px] font-bold text-navy">{step.title}</h2>
              <span className="ml-auto">
                <Button disabled={running || !available || state.status === "done"} onClick={() => run(index)}>
                  {state.status === "running" ? "실행 중…" : state.status === "done" ? "완료" : state.status === "error" ? "다시 실행" : "실행"}
                </Button>
              </span>
            </header>
            <div className="space-y-2 p-3 text-[12px] leading-relaxed">
              <p>{step.what}</p>
              <p className="text-mute">
                <b className="text-ink">왜 이렇게 하나요?</b> {step.why}
              </p>
              {state.status === "running" && <Notice>블록체인에 반영되기를 기다리는 중입니다…</Notice>}
              {state.status === "error" && (
                <Notice tone="warn">
                  이 단계를 끝내지 못했습니다: {state.error} <br />
                  잠시 후 “다시 실행”을 눌러 보세요.
                </Notice>
              )}
              {state.lines.length > 0 && (
                <ul className="space-y-1.5 border-t border-line pt-2">
                  {state.lines.map((line, lineIndex) => (
                    <li key={lineIndex} className="flex gap-2">
                      {line.kind === "done" && <span className="shrink-0 font-bold text-ok">✔ 실행됨</span>}
                      {line.kind === "blocked" && <span className="shrink-0 font-bold text-no">⛔ 막힘</span>}
                      {line.kind === "info" && <span className="shrink-0 font-bold text-mute">ℹ 참고</span>}
                      <span className="min-w-0">
                        {line.text}
                        {line.code && (
                          <span className="mt-0.5 block border-l-2 border-no/40 pl-2 text-mute">
                            <b className="text-no">{explain(line.code).title}</b> <Mono>({line.code})</Mono>
                            <br />
                            {explain(line.code).why}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })}

      {nextIndex === -1 && (
        <Panel title="시나리오를 마쳤습니다">
          <p className="text-[13px]">방금 한 작업들은 콘솔의 다른 화면에 그대로 반영되어 있습니다. 이어서 둘러보세요.</p>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {AFTER.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="block border border-line p-2 hover:border-navy">
                  <b className="text-navy">{item.label}</b>
                  <span className="block text-[12px] text-mute">{item.body}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button variant="ghost" onClick={restart}>
              새 투자자로 처음부터 다시
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
