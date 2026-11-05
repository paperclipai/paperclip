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
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

function sanitize(input: { httpStatus?: unknown; errorCode?: unknown }): PluginEnvironmentResumeErrorDiagnostic | null {
  const httpStatus = Number.isInteger(input.httpStatus) && (input.httpStatus as number) >= 100 && (input.httpStatus as number) <= 599
    ? input.httpStatus as number : undefined;
  const errorCode = typeof input.errorCode === "string" && ERROR_CODES.has(input.errorCode) ? input.errorCode : undefined;
  if (httpStatus === undefined && errorCode === undefined) return null;
  return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
}

/** Worker side: derive safe fields from a thrown provider error and its causes. */
export function environmentResumeErrorData(error: unknown): { schema: string; diagnostic: PluginEnvironmentResumeErrorDiagnostic } | undefined {
  let httpStatus: unknown;
  let errorCode: unknown;
  for (let cause = error, depth = 0; cause && depth < 4; cause = field(cause, "cause"), depth++) {
    httpStatus ??= [field(cause, "status"), field(cause, "statusCode"), field(field(cause, "response"), "status")]
      .find(value => Number.isInteger(value));
    const code = field(cause, "code");
    if (errorCode === undefined && typeof code === "string" && ERROR_CODES.has(code)) errorCode = code;
  }
  const diagnostic = sanitize({ httpStatus, errorCode });
  return diagnostic ? { schema: SCHEMA, diagnostic } : undefined;
}

/** Host side: read and re-validate the envelope from an RPC error. */
export function readEnvironmentResumeErrorDiagnostic(error: unknown): PluginEnvironmentResumeErrorDiagnostic | null {
  const data = field(error, "data");
  if (field(data, "schema") !== SCHEMA) return null;
  const diagnostic = field(data, "diagnostic");
  return sanitize({ httpStatus: field(diagnostic, "httpStatus"), errorCode: field(diagnostic, "errorCode") });
}
