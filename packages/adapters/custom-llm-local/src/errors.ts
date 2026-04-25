import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export type ErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_FAILED"
  | "ENDPOINT_UNREACHABLE"
  | "TIMEOUT"
  | "MODEL_REJECTED"
  | "UPSTREAM_ERROR"
  | "BAD_RESPONSE";

export interface CustomLlmError {
  code: ErrorCode;
  message: string;
  meta?: Record<string, unknown>;
}

export function buildErrorResult(err: CustomLlmError): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: err.code === "TIMEOUT",
    errorMessage: err.message,
    errorCode: err.code,
    errorMeta: err.meta,
  };
}

/**
 * Map a fetch error (ECONNREFUSED, ENOTFOUND, etc.) to the correct error code.
 * Must be called before reading the response body.
 */
export function classifyFetchError(err: unknown): CustomLlmError {
  const msg = err instanceof Error ? err.message : String(err);

  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError")
  ) {
    return { code: "ENDPOINT_UNREACHABLE", message: `Endpoint unreachable: ${msg}` };
  }

  if (msg.includes("AbortError") || msg.includes("The operation was aborted")) {
    return { code: "TIMEOUT", message: msg };
  }

  return { code: "ENDPOINT_UNREACHABLE", message: `Fetch error: ${msg}` };
}

/**
 * Map an HTTP status code to the correct error code.
 */
export function classifyHttpStatus(status: number, body: string): CustomLlmError {
  if (status === 401 || status === 403) {
    return { code: "AUTH_FAILED", message: `Authentication failed (HTTP ${status})`, meta: { status, body: body.slice(0, 500) } };
  }
  if (status >= 400 && status < 500) {
    return { code: "MODEL_REJECTED", message: `Request rejected by endpoint (HTTP ${status})`, meta: { status, body: body.slice(0, 500) } };
  }
  if (status >= 500) {
    return { code: "UPSTREAM_ERROR", message: `Upstream server error (HTTP ${status})`, meta: { status, body: body.slice(0, 500) } };
  }
  return { code: "BAD_RESPONSE", message: `Unexpected HTTP status ${status}`, meta: { status } };
}
