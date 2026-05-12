import type { AdapterExecutionResult } from "../types.js";

export interface CallbackPayload {
  status: string;
  result?: string | null;
  errorMessage?: string | null;
}

type PendingEntry = {
  resolve: (result: AdapterExecutionResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const pending = new Map<string, PendingEntry>();

export function registerCallback(runId: string, timeoutMs: number): Promise<AdapterExecutionResult> {
  return new Promise<AdapterExecutionResult>((resolve) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (pending.delete(runId)) {
              resolve({ exitCode: null, signal: null, timedOut: true, errorCode: "callback_timeout" });
            }
          }, timeoutMs)
        : null;
    pending.set(runId, { resolve, timer });
  });
}

export function resolveCallback(runId: string, payload: CallbackPayload): boolean {
  const entry = pending.get(runId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(runId);
  const succeeded = payload.status === "succeeded";
  entry.resolve({
    exitCode: succeeded ? 0 : 1,
    signal: null,
    timedOut: false,
    summary: payload.result ?? null,
    errorMessage: succeeded ? null : (payload.errorMessage ?? "run failed"),
  });
  return true;
}
