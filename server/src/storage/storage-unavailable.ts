import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { storageFailureDiagnosticsFor } from "./failure-diagnostics.js";
import { recordStorageBackoff } from "./request-stats.js";

export const STORAGE_UNAVAILABLE_CODE = "storage_unavailable";

export const STORAGE_UNAVAILABLE_WAIT_RETRY_REASON = "storage_unavailable_wait";

export const STORAGE_UNAVAILABLE_MESSAGE = "File storage was unavailable, so this attempt stopped before it could save its work. Paperclip will retry automatically when storage is back.";

export const STORAGE_UNAVAILABLE_RETRY = {
  retryReason: STORAGE_UNAVAILABLE_WAIT_RETRY_REASON, wakeReason: "storage_unavailable_retry", maxAttempts: 10, delayMs: 60_000,
} as const;

const UNAVAILABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const UNAVAILABLE_NAMES = new Set(["ServiceUnavailable", "SlowDown", "InternalError", "RequestTimeout", "TimeoutError", "NetworkingError"]);
const UNAVAILABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"]);

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function networkFailure(error: unknown): boolean {
  for (const candidate of [error, ownValue(error, "cause")]) {
    const name = ownValue(candidate, "name"), code = ownValue(candidate, "code");
    if ((typeof name === "string" && UNAVAILABLE_NAMES.has(name)) || (typeof code === "string" && UNAVAILABLE_CODES.has(code))) return true;
  }
  return false;
}

function recordedStorageFailure(error: unknown) {
  for (let candidate = error, depth = 0; candidate && depth < 6; candidate = ownValue(candidate, "cause"), depth++) {
    const diagnostics = storageFailureDiagnosticsFor(candidate);
    if (diagnostics) return { error: candidate, diagnostics };
  }
  return null;
}

export function isStorageUnavailableError(error: unknown): boolean {
  const recorded = recordedStorageFailure(error);
  if (!recorded) return false;
  const { diagnostics } = recorded;
  const status = diagnostics.httpStatus;
  if (status !== null && (status < 200 || status >= 300)) return UNAVAILABLE_STATUS.has(status);
  return UNAVAILABLE_NAMES.has(diagnostics.errorCode) || UNAVAILABLE_CODES.has(diagnostics.errorCode) || networkFailure(recorded.error);
}

export const STORAGE_OUTAGE_WAIT = { budgetMs: 5 * 60_000, firstDelayMs: 2_000, maxDelayMs: 30_000 } as const;

const outageWaitScope = new AsyncLocalStorage<true>();

export function waitOutStorageOutages<T>(work: () => Promise<T>): Promise<T> {
  return outageWaitScope.run(true, work);
}

export async function retryThroughStorageOutage<T>(send: () => Promise<T>, signal?: AbortSignal,
  policy: { budgetMs: number; firstDelayMs: number; maxDelayMs: number } = STORAGE_OUTAGE_WAIT): Promise<T> {
  const startedAt = Date.now();
  for (let wait = policy.firstDelayMs; ; wait = Math.min(wait * 2, policy.maxDelayMs)) {
    try {
      return await send();
    } catch (error) {
      if (signal?.aborted || !isStorageUnavailableError(error) || Date.now() - startedAt + wait > policy.budgetMs) throw error;
      recordStorageBackoff(wait);
      await delay(wait, undefined, { signal }).catch((interrupted: unknown) => {
        throw signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? error : interrupted;
      });
    }
  }
}

export function sendThroughStorageOutage<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return outageWaitScope.getStore() ? retryThroughStorageOutage(send, signal) : send();
}
