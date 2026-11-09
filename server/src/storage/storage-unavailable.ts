import { storageFailureDiagnosticsFor } from "./failure-diagnostics.js";

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

export function isStorageUnavailableError(error: unknown): boolean {
  const diagnostics = storageFailureDiagnosticsFor(error);
  if (!diagnostics) return false;
  const status = diagnostics.httpStatus;
  if (status !== null && (status < 200 || status >= 300)) return UNAVAILABLE_STATUS.has(status);
  return UNAVAILABLE_NAMES.has(diagnostics.errorCode) || UNAVAILABLE_CODES.has(diagnostics.errorCode) || networkFailure(error);
}
