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

export const ENVIRONMENT_TASK_ERROR_CODES = ["runner_revision_mismatch"] as const;
export type PluginEnvironmentTaskErrorCode = typeof ENVIRONMENT_TASK_ERROR_CODES[number];

const CODE_SCHEMA = "paperclip/environment-task-error-code/v1";

function ownField(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

function validateCode(value: unknown): PluginEnvironmentTaskErrorCode | null {
  return ENVIRONMENT_TASK_ERROR_CODES.includes(value as PluginEnvironmentTaskErrorCode)
    ? value as PluginEnvironmentTaskErrorCode : null;
}

export class PluginEnvironmentTaskError extends Error {
  readonly errorCode: PluginEnvironmentTaskErrorCode;

  constructor(errorCode: PluginEnvironmentTaskErrorCode) {
    const safe = validateCode(errorCode);
    if (!safe) throw new TypeError("Unknown environment task error code");
    super("The installed Runner does not match the expected revision");
    this.name = "PluginEnvironmentTaskError";
    this.errorCode = safe;
  }
}

export function environmentTaskErrorCodeData(error: unknown): { schema: string; errorCode: PluginEnvironmentTaskErrorCode } | undefined {
  if (!(error instanceof PluginEnvironmentTaskError)) return undefined;
  const errorCode = validateCode(ownField(error, "errorCode"));
  return errorCode ? { schema: CODE_SCHEMA, errorCode } : undefined;
}

export function readEnvironmentTaskErrorCode(error: unknown): PluginEnvironmentTaskErrorCode | null {
  for (let current = error, depth = 0; current && depth < 5; current = ownField(current, "cause"), depth++) {
    const data = ownField(current, "data");
    if (ownField(data, "schema") === CODE_SCHEMA) {
      const code = validateCode(ownField(data, "errorCode"));
      if (code) return code;
    }
  }
  return null;
}
