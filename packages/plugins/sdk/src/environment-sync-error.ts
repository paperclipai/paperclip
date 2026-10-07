/** Diagnostic evidence only. Never use this envelope to authorize cleanup or retry. */
export interface PluginEnvironmentSyncErrorDiagnostic {
  errorCode: string;
  httpStatus?: number;
  exitCode?: number;
}

const SCHEMA = "paperclip/environment-sync-error/v1";
// Match the host's workspace restore diagnostic allowlist. Both sides validate
// independently: plugin-supplied data must never widen the host's log surface.
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EXDEV", "ENOTDIR", "EISDIR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value : undefined;
}

function sanitize(value: unknown): PluginEnvironmentSyncErrorDiagnostic | undefined {
  const code = field(value, "errorCode");
  const errorCode = typeof code === "string" && ERROR_CODES.has(code) ? code : "unknown";
  const httpStatus = integer(field(value, "httpStatus"), 400, 599);
  const exitCode = integer(field(value, "exitCode"), 1, 255);
  if (errorCode === "unknown" && httpStatus === undefined && exitCode === undefined) return undefined;
  return { errorCode, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** Capture known codes and numbers, never arbitrary error data, text, or names. */
export function environmentSyncErrorData(error: unknown): unknown {
  const diagnostic: PluginEnvironmentSyncErrorDiagnostic = { errorCode: "unknown" };
  let current = error;
  // Bound nested SDK causes, including cyclic errors and throwing getters.
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = field(current, "code");
    if (diagnostic.errorCode === "unknown" && typeof code === "string" && ERROR_CODES.has(code)) diagnostic.errorCode = code;
    diagnostic.httpStatus ??= integer(field(current, "status"), 400, 599)
      ?? integer(field(current, "statusCode"), 400, 599)
      ?? integer(field(field(current, "response"), "status"), 400, 599);
    diagnostic.exitCode ??= integer(field(current, "exitCode"), 1, 255) ?? integer(code, 1, 255);
    current = field(current, "cause");
  }
  const safe = sanitize(diagnostic);
  return safe ? { schema: SCHEMA, diagnostic: safe } : undefined;
}

/** Revalidate the worker envelope before adapting it into host-only diagnostics. */
export function readEnvironmentSyncErrorDiagnostic(error: unknown): PluginEnvironmentSyncErrorDiagnostic | undefined {
  const data = field(error, "data");
  return field(data, "schema") === SCHEMA ? sanitize(field(data, "diagnostic")) : undefined;
}
