/**
 * Diagnostic evidence for a refused `environmentResumeLease`. It crosses the
 * worker RPC boundary as structured error data, because the JSON-RPC error
 * carries only a message and a numeric RPC code. Never use it to authorize
 * replacement or cleanup: a refusal does not prove that a sandbox is lost.
 */
export interface PluginEnvironmentResumeErrorDiagnostic {
  httpStatus?: number;
  errorCode?: string;
}

const SCHEMA = "paperclip/environment-resume-error/v1";
// Closed errno-style set. Provider text and identifiers never cross.
const ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CONNECTION_FAILED",
]);

/**
 * Where a retry would go. `first_acquisition` may target a host that was never
 * reached, so a name that does not resolve is not retried. `known_host` resumes
 * an exact lease that this run already reached, so a failed lookup is an outage.
 */
export type EnvironmentRetryScope = "first_acquisition" | "known_host";

// The retryable subset of the envelope vocabulary. ABORT_ERR is a caller's own
// cancellation: a provider that hit its own deadline reports ETIMEDOUT instead.
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CONNECTION_FAILED",
]);
const KNOWN_HOST_RETRYABLE_ERROR_CODES = new Set([...RETRYABLE_ERROR_CODES, "ENOTFOUND"]);
// 501 and 505 are deterministic. Gateway and edge statuses (520-527, 529, 598, 599) are not.
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 598, 599]);

/** Whether a provider errno is worth a bounded retry in this scope. */
export function isRetryableEnvironmentErrorCode(code: unknown, scope: EnvironmentRetryScope = "first_acquisition"): boolean {
  return typeof code === "string" && (scope === "known_host" ? KNOWN_HOST_RETRYABLE_ERROR_CODES : RETRYABLE_ERROR_CODES).has(code);
}

/** Whether a provider HTTP status is worth a bounded retry. */
export function isRetryableEnvironmentHttpStatus(status: unknown): boolean {
  return typeof status === "number" && RETRYABLE_HTTP_STATUSES.has(status);
}

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/** Shared with the acquisition envelope: the same closed status/errno fields. */
export function sanitizeProviderErrorDiagnostic(input: { httpStatus?: unknown; errorCode?: unknown }): PluginEnvironmentResumeErrorDiagnostic | null {
  const httpStatus = Number.isInteger(input.httpStatus) && (input.httpStatus as number) >= 100 && (input.httpStatus as number) <= 599
    ? input.httpStatus as number : undefined;
  const errorCode = typeof input.errorCode === "string" && ERROR_CODES.has(input.errorCode) ? input.errorCode : undefined;
  if (httpStatus === undefined && errorCode === undefined) return null;
  return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
}

/** Derive the closed status/errno fields from a thrown provider error and its causes. */
export function providerErrorDiagnostic(error: unknown): PluginEnvironmentResumeErrorDiagnostic | null {
  let httpStatus: unknown;
  let errorCode: unknown;
  for (let cause = error, depth = 0; cause && depth < 4; cause = field(cause, "cause"), depth++) {
    httpStatus ??= [field(cause, "status"), field(cause, "statusCode"), field(field(cause, "response"), "status")]
      .find(value => Number.isInteger(value));
    const code = field(cause, "code");
    if (errorCode === undefined && typeof code === "string" && ERROR_CODES.has(code)) errorCode = code;
  }
  return sanitizeProviderErrorDiagnostic({ httpStatus, errorCode });
}

/** Worker side: derive safe fields from a thrown provider error and its causes. */
export function environmentResumeErrorData(error: unknown): { schema: string; diagnostic: PluginEnvironmentResumeErrorDiagnostic } | undefined {
  const diagnostic = providerErrorDiagnostic(error);
  return diagnostic ? { schema: SCHEMA, diagnostic } : undefined;
}

/** Host side: read and re-validate the envelope from an RPC error. */
export function readEnvironmentResumeErrorDiagnostic(error: unknown): PluginEnvironmentResumeErrorDiagnostic | null {
  const data = field(error, "data");
  if (field(data, "schema") !== SCHEMA) return null;
  const diagnostic = field(data, "diagnostic");
  return sanitizeProviderErrorDiagnostic({ httpStatus: field(diagnostic, "httpStatus"), errorCode: field(diagnostic, "errorCode") });
}
