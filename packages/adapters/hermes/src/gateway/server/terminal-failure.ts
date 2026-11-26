import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const TERMINAL_STOP_STATUSES = new Set(["completed", ...FAILURE_STATUSES, ...CANCELLED_STATUSES]);

const TERMINAL_PROVIDER_QUOTA_CODES = new Set([
  "insufficient_quota",
  "usage_limit_reached",
  "quota_exceeded",
  "billing_hard_limit_reached",
]);

const TERMINAL_TRANSIENT_ERROR_CODES = new Set([
  "rate_limit_error",
  "overloaded_error",
  "service_unavailable",
  "api_connection_error",
  "server_error",
  "internal_server_error",
  "bad_gateway",
  "gateway_timeout",
  "too_many_requests",
]);

const TERMINAL_PROVIDER_QUOTA_RE =
  /(?:insufficient_quota|usage\s+limit\s+reached|usage\s+cap\s+reached|quota\s+exceeded|exceeded\s+your\s+(?:current\s+)?quota|you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|servicequotaexceededexception)/i;

const MESSAGE_HTTP_STATUS_RE =
  /(?:^|[^\w])(?:http(?:\/\d+(?:\.\d+)?)?|status(?:[_\s-]?code)?|api\s+error)\s*[:=]?\s*(\d{3})\b/i;

const TERMINAL_TRANSIENT_UPSTREAM_RE =
  /(?:\b(?:http(?:\/\d+(?:\.\d+)?)?|status(?:[_\s-]?code)?|api\s+error)\s*[:=]?\s*(?:429|500|502|503|504|529)\b|rate[-\s_]?limit(?:ed|_error)?|too\s+many\s+requests|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|bad\s+gateway|gateway\s+timeout|temporarily\s+unavailable|high\s+demand|try\s+again\s+later|throttl(?:ed|ing)|throttlingexception)/i;

const TERMINAL_GATEWAY_SHUTDOWN_RE =
  /(?:gateway\s+(?:shutdown|restart)|(?:shutdown|restart)\s+interrupted\s+the\s+run)/i;

const MAX_EPOCH_MS = 8_640_000_000_000_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseTerminalStatusCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function parseMessageHttpStatusCode(message: string | null): number | null {
  if (!message) return null;
  const match = MESSAGE_HTTP_STATUS_RE.exec(message);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return parsed >= 100 && parsed <= 599 ? parsed : null;
}

function formatValidIsoDate(ms: number): string | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseTerminalRetryNotBefore(payload: Record<string, unknown>, nowMs = Date.now()): string | null {
  const nestedError = asRecord(payload.error);
  const direct = nonEmpty(payload.retry_not_before)
    ?? nonEmpty(payload.retryNotBefore)
    ?? nonEmpty(nestedError?.retry_not_before)
    ?? nonEmpty(nestedError?.retryNotBefore);
  if (direct) {
    const formatted = formatValidIsoDate(Date.parse(direct));
    if (formatted) return formatted;
  }
  const retryAfter = payload.retry_after
    ?? payload.retryAfter
    ?? payload.retry_after_seconds
    ?? payload.retryAfterSeconds
    ?? nestedError?.retry_after
    ?? nestedError?.retryAfter
    ?? nestedError?.retry_after_seconds
    ?? nestedError?.retryAfterSeconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return formatValidIsoDate(nowMs + Math.ceil(retryAfter * 1000));
  }
  if (typeof retryAfter === "string" && retryAfter.trim().length > 0) {
    const trimmed = retryAfter.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const seconds = Number.parseFloat(trimmed);
      if (Number.isFinite(seconds) && seconds > 0) {
        return formatValidIsoDate(nowMs + Math.ceil(seconds * 1000));
      }
    }
    return formatValidIsoDate(Date.parse(trimmed));
  }
  return null;
}

export function classifyTerminalFailure(
  status: string,
  payload: Record<string, unknown>,
  errorMessage: string | null,
): { errorFamily: AdapterExecutionResult["errorFamily"]; retryNotBefore: string | null; gatewayShutdown: boolean } {
  let errorFamily: AdapterExecutionResult["errorFamily"] = null;
  let gatewayShutdown = false;
  if (FAILURE_STATUSES.has(status)) {
    const nestedError = asRecord(payload.error);
    const codeField = (nonEmpty(nestedError?.code) ?? nonEmpty(payload.error_code) ?? nonEmpty(payload.errorCode))?.toLowerCase() ?? null;
    const typeField = (nonEmpty(nestedError?.type) ?? nonEmpty(payload.error_type) ?? nonEmpty(payload.errorType))?.toLowerCase() ?? null;
    const statusCode = parseTerminalStatusCode(
      nestedError?.status_code
        ?? nestedError?.statusCode
        ?? nestedError?.status
        ?? payload.status_code
        ?? payload.statusCode
        ?? payload.http_status
        ?? payload.httpStatus,
    ) ?? parseMessageHttpStatusCode(errorMessage);
    const isQuota = (codeField !== null && TERMINAL_PROVIDER_QUOTA_CODES.has(codeField))
      || (typeField !== null && TERMINAL_PROVIDER_QUOTA_CODES.has(typeField))
      || (errorMessage !== null && TERMINAL_PROVIDER_QUOTA_RE.test(errorMessage));
    if (isQuota) {
      errorFamily = "provider_quota";
    } else {
      const isNonTransientClientStatus = statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      if (!isNonTransientClientStatus) {
        const isTransientStatus = statusCode === 429 || statusCode === 529 || (statusCode !== null && statusCode >= 500);
        const isTransientField = (typeField !== null && TERMINAL_TRANSIENT_ERROR_CODES.has(typeField))
          || (codeField !== null && TERMINAL_TRANSIENT_ERROR_CODES.has(codeField));
        if (isTransientStatus || isTransientField || (errorMessage !== null && TERMINAL_TRANSIENT_UPSTREAM_RE.test(errorMessage))) {
          errorFamily = "transient_upstream";
        }
      }
    }
  } else if (CANCELLED_STATUSES.has(status) && errorMessage !== null && TERMINAL_GATEWAY_SHUTDOWN_RE.test(errorMessage)) {
    errorFamily = "transient_upstream";
    gatewayShutdown = true;
  }
  const retryNotBefore = errorFamily ? parseTerminalRetryNotBefore(payload) : null;
  return { errorFamily, retryNotBefore, gatewayShutdown };
}

/**
 * Remote hermes_gateway runs have no local host PID; require either a saved
 * terminal gateway status or a pre-request configuration failure (returned
 * before any outbound fetch). Outbound create_run HTTP 429/5xx and transport
 * failures intentionally fail closed because redirect-following fetch or an
 * intermediary may have already created the remote run and retries mint a new
 * Idempotency-Key.
 */
export function hasHermesGatewayTerminalStopProof(
  resultJson: Record<string, unknown> | null | undefined,
): boolean {
  const result = asRecord(resultJson);
  if (!result) return false;
  const status = nonEmpty(result.status)?.toLowerCase() ?? "";
  if (TERMINAL_STOP_STATUSES.has(status)) return true;
  const connectionFailure = asRecord(result.connectionFailure);
  return connectionFailure?.provider === "hermes_gateway" && connectionFailure?.operation === "configuration";
}
