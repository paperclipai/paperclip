/** Diagnostic only. A refusal never authorizes replacement, retry or cleanup. */
export interface PluginEnvironmentTaskErrorDiagnostic {
  httpStatus: 409;
  errorCode: "SESSION_STATE_UNAVAILABLE";
  reason: "unresolved_operation" | "source_state_unverified";
}

const SCHEMA = "paperclip/environment-task-error/v1";

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

function sanitize(httpStatus: unknown, errorCode: unknown, reason: unknown): PluginEnvironmentTaskErrorDiagnostic | null {
  if (httpStatus !== 409 || errorCode !== "SESSION_STATE_UNAVAILABLE" ||
      (reason !== "unresolved_operation" && reason !== "source_state_unverified")) return null;
  return { httpStatus, errorCode, reason };
}

/** Worker side: copy only the closed refusal fields, never provider text or identities. */
export function environmentTaskErrorData(error: unknown): {
  schema: string; diagnostic: PluginEnvironmentTaskErrorDiagnostic;
} | undefined {
  const diagnostic = sanitize(field(error, "status"), field(error, "code"), field(error, "reason"));
  return diagnostic ? { schema: SCHEMA, diagnostic } : undefined;
}

/** Host side: validate the envelope again after the worker RPC. */
export function readEnvironmentTaskErrorDiagnostic(error: unknown): PluginEnvironmentTaskErrorDiagnostic | null {
  const data = field(error, "data");
  if (field(data, "schema") !== SCHEMA) return null;
  const diagnostic = field(data, "diagnostic");
  return sanitize(field(diagnostic, "httpStatus"), field(diagnostic, "errorCode"), field(diagnostic, "reason"));
}
