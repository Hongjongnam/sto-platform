"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { explain } from "../lib/format";

export function Panel({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line bg-head px-3 py-1.5">
          <h2 className="text-[13px] font-bold text-navy">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info";
const TONES: Record<Tone, string> = {
  neutral: "border-line bg-head text-mute",
  good: "border-ok/30 bg-ok/10 text-ok",
  bad: "border-no/30 bg-no/10 text-no",
  warn: "border-amber-400/40 bg-amber-50 text-amber-700",
  info: "border-accent/30 bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap border px-1.5 py-px text-[11px] font-semibold ${TONES[tone]}`}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "대기", tone: "warn" },
  SUBMITTED: { label: "전송됨", tone: "warn" },
  CONFIRMED: { label: "확정", tone: "good" },
  FAILED: { label: "거부", tone: "bad" },
  PENDING_APPROVAL: { label: "승인 대기", tone: "warn" },
  APPROVED: { label: "승인", tone: "good" },
  REJECTED: { label: "반려", tone: "bad" },
  VERIFIED: { label: "인증", tone: "good" },
  EXPIRED: { label: "만료", tone: "bad" },
  REVOKED: { label: "철회", tone: "bad" },
  SETTLED: { label: "결제 완료", tone: "good" },
  CANCELLING: { label: "취소 중", tone: "warn" },
  CANCELLED: { label: "취소", tone: "neutral" },
  OPENING: { label: "개설 중", tone: "warn" },
  OPEN: { label: "진행 중", tone: "info" },
  CLOSING: { label: "마감 중", tone: "warn" },
  CLOSED: { label: "마감", tone: "neutral" },
};

export function StatusBadge({ status }: { status: string }) {
  const known = STATUS[status];
  return <Badge tone={known?.tone ?? "neutral"}>{known?.label ?? status}</Badge>;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-navy text-white hover:bg-navy-deep",
    ghost: "border border-line bg-white text-ink hover:bg-head",
    danger: "bg-accent text-white hover:opacity-90",
  }[variant];
  return (
    <button
      {...props}
      className={`px-3 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold text-mute">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-mute">{hint}</span>}
    </label>
  );
}

const CONTROL = "w-full border border-line bg-white px-2 py-1.5 text-[12px] outline-none focus:border-navy";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  width?: string;
}

/** Dense table. On narrow screens each row becomes a card of label/value pairs. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = "표시할 내용이 없습니다.",
  onRowClick,
  selectedKey,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  empty?: string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
}) {
  if (!rows) return <p className="py-6 text-center text-mute">불러오는 중…</p>;
  if (rows.length === 0) return <p className="py-6 text-center text-mute">{empty}</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-head text-mute">
              {columns.map((column) => (
                <th key={column.header} style={{ width: column.width }} className={`border-b border-line px-2 py-1.5 font-semibold ${column.numeric ? "text-right" : "text-left"}`}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-line/70 ${onRowClick ? "cursor-pointer hover:bg-accent-soft/50" : ""} ${selectedKey === key ? "bg-accent-soft" : ""}`}
                >
                  {columns.map((column) => (
                    <td key={column.header} className={`px-2 py-1.5 align-middle ${column.numeric ? "num" : ""}`}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className="border border-line bg-white p-2">
            {columns.map((column) => (
              <div key={column.header} className="flex justify-between gap-3 py-0.5">
                <span className="shrink-0 text-mute">{column.header}</span>
                <span className="min-w-0 break-all text-right">{column.cell(row)}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px]">{children}</span>;
}

/** Explains a contract rejection in plain language. */
export function Rejection({ code, detail }: { code: string | null | undefined; detail?: string | null }) {
  const { title, why } = explain(code);
  return (
    <div className="border border-no/30 bg-no/5 p-2 text-[12px]">
      <p className="font-bold text-no">
        거부됨 · {title} {code && <Mono>({code})</Mono>}
      </p>
      {why && <p className="mt-1 text-ink">{why}</p>}
      {detail && <p className="mt-1 break-all text-mute">{detail}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  const style = tone === "warn" ? "border-amber-400/50 bg-amber-50" : "border-navy/20 bg-navy/5";
  return <div className={`border-l-4 px-3 py-2 text-[12px] leading-relaxed ${style}`}>{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="border border-line bg-panel px-3 py-2">
      <p className="text-[11px] font-semibold text-mute">{label}</p>
      <p className="num mt-0.5 text-left text-[18px] font-bold text-navy">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-mute">{sub}</p>}
    </div>
  );
}
