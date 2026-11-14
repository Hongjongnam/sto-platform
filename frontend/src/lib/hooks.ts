"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Operation, Transaction } from "./api";
import { useSession } from "./session";

const POLL_MS = 2_000;

/** Reads `path` as the current operator and keeps it fresh while the page is open. */
export function useApiQuery<T>(path: string, options: { enabled?: boolean; poll?: boolean } = {}) {
  const { session, call } = useSession();
  return useQuery({
    queryKey: [path],
    queryFn: () => call<T>(path),
    enabled: !!session && options.enabled !== false,
    refetchInterval: options.poll === false ? false : POLL_MS,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helpers that wait for the chain to settle, then refresh every list on screen. */
export function useChainActions() {
  const { call } = useSession();
  const queryClient = useQueryClient();
  const refresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  /** Waits until an operation's transaction is confirmed or rejected. Returns early if it still needs approval. */
  const waitForOperation = useCallback(
    async (id: string): Promise<Operation> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const operation = await call<Operation>(`/operations/${id}`, { as: "requester" });
        const done = operation.status !== "APPROVED" || operation.execution?.status === "CONFIRMED" || operation.execution?.status === "FAILED";
        if (done) {
          await refresh();
          return operation;
        }
        await sleep(700);
      }
      throw new Error("체인 반영을 기다리다 시간이 초과되었습니다.");
    },
    [call, refresh],
  );

  /** Waits until a transaction the backend was asked to send is confirmed or rejected. */
  const waitForTransaction = useCallback(
    async (id: string): Promise<Transaction> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const transaction = await call<Transaction>(`/transactions/${id}`, { as: "requester" });
        if (transaction.status === "CONFIRMED" || transaction.status === "FAILED") {
          await refresh();
          return transaction;
        }
        await sleep(700);
      }
      throw new Error("체인 반영을 기다리다 시간이 초과되었습니다.");
    },
    [call, refresh],
  );

  /** Polls `read` until `done` accepts its result. */
  const waitUntil = useCallback(
    async <T,>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const value = await read();
        if (done(value)) {
          await refresh();
          return value;
        }
        await sleep(700);
      }
      throw new Error("체인 반영을 기다리다 시간이 초과되었습니다.");
    },
    [refresh],
  );

  return { waitForOperation, waitForTransaction, waitUntil, refresh };
}
