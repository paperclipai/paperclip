import { storageFailureDiagnosticsFor } from "./failure-diagnostics.js";

export const STORAGE_UNAVAILABLE_CODE = "storage_unavailable";

export const STORAGE_UNAVAILABLE_WAIT_RETRY_REASON = "storage_unavailable_wait";

export const STORAGE_UNAVAILABLE_MESSAGE = "File storage was unavailable, so this attempt stopped before it could save its work. Paperclip will retry automatically when storage is back.";

export const STORAGE_UNAVAILABLE_RETRY = {
  retryReason: STORAGE_UNAVAILABLE_WAIT_RETRY_REASON, wakeReason: "storage_unavailable_retry", maxAttempts: 10, delayMs: 60_000,
} as const;

const UNAVAILABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const UNAVAILABLE_NAMES = new Set(["ServiceUnavailable", "SlowDown", "InternalError", "RequestTimeout", "TimeoutError", "NetworkingError"]);
const UNAVAILABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND"]);

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isStorageTimeoutAbort(error: unknown): boolean {
  if (ownValue(error, "name") !== "AbortError") return false;
  const cause = ownValue(error, "cause");
  return Boolean(cause && typeof cause === "object" && (cause as { name?: unknown }).name === "TimeoutError");
}

export function isStorageUnavailableError(error: unknown): boolean {
  if (isStorageTimeoutAbort(error)) return true;
  const diagnostics = storageFailureDiagnosticsFor(error);
  if (diagnostics) return diagnostics.httpStatus === null
    ? UNAVAILABLE_CODES.has(diagnostics.errorCode) || UNAVAILABLE_NAMES.has(diagnostics.errorCode)
    : UNAVAILABLE_STATUS.has(diagnostics.httpStatus);
  const metadata = ownValue(error, "$metadata");
  if (!metadata || typeof metadata !== "object") return false;
  const status = ownValue(metadata, "httpStatusCode");
  if (typeof status === "number") return UNAVAILABLE_STATUS.has(status);
  const name = ownValue(error, "name"), code = ownValue(error, "code");
  return (typeof name === "string" && UNAVAILABLE_NAMES.has(name)) || (typeof code === "string" && UNAVAILABLE_CODES.has(code));
}
