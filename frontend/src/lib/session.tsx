"use client";

import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import { apiFetch } from "./api";

export type Perspective = "requester" | "approver" | "investor";

interface DemoSession {
  requester: { accessToken: string; displayName: string };
  approver: { accessToken: string; displayName: string };
}

interface Stored {
  session: DemoSession | null;
  perspective: Perspective;
}

interface SessionContext extends Stored {
  /** False during server rendering and hydration, before browser storage has been read. */
  ready: boolean;
  setPerspective: (perspective: Perspective) => void;
  /** Starts a demo session: no sign-up, one token for each of the two demo operators. */
  enter: () => Promise<void>;
  leave: () => void;
  /** Calls the API as the operator of the current perspective, or as the one named. */
  call: <T>(path: string, options?: { body?: unknown; method?: string; as?: "requester" | "approver" }) => Promise<T>;
}

// The session lives in sessionStorage so a reload keeps the visitor signed in. It is read
// through an external store so the server-rendered shell and the first client render agree.
const STORAGE_KEY = "sto-demo-session";
const EMPTY: Stored = { session: null, perspective: "requester" };
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: Stored } = { raw: null, value: EMPTY };

function read(): Stored {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: behave as signed out.
  }
  if (raw !== cache.raw) {
    let value = EMPTY;
    try {
      if (raw) value = JSON.parse(raw) as Stored;
    } catch {
      // Corrupt entry: behave as signed out.
    }
    cache = { raw, value };
  }
  return cache.value;
}

function write(next: Stored): void {
  const raw = JSON.stringify(next);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage unavailable: keep the session in memory until the page is closed.
  }
  cache = { raw, value: next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const stored = useSyncExternalStore<Stored | null>(subscribe, read, () => null);

  const value = useMemo<SessionContext>(() => {
    const { session, perspective } = stored ?? EMPTY;
    return {
      ready: stored !== null,
      session,
      perspective,
      setPerspective: (next) => write({ session, perspective: next }),
      enter: async () => write({ session: await apiFetch<DemoSession>("/demo/session", { method: "POST" }), perspective }),
      leave: () => write({ session: null, perspective }),
      call: (path, options = {}) => {
        if (!session) return Promise.reject(new Error("세션이 없습니다. 처음 화면에서 데모에 입장해 주세요."));
        // The investor view acts through the requester account: the backend is custodial.
        const role = options.as ?? (perspective === "approver" ? "approver" : "requester");
        return apiFetch(path, { token: session[role].accessToken, body: options.body, method: options.method });
      },
    };
  }, [stored]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionContext {
  const context = useContext(Context);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}
