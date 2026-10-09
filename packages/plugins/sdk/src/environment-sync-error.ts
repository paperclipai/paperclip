import { AsyncLocalStorage } from "node:async_hooks";

/** Diagnostic evidence only. Never use this envelope to authorize cleanup or retry. */
export interface PluginEnvironmentSyncErrorDiagnostic {
  errorCode: string;
  httpStatus?: number;
  exitCode?: number;
  transferStep?: EnvironmentSyncTransferStep;
  transferFailureKind?: EnvironmentSyncTransferFailureKind;
}

const TRANSFER_STEPS = new Set([
  "sandbox_access", "sandbox_guard", "file_download", "file_finalize",
  "archive_create", "archive_download", "archive_validate", "archive_extract",
] as const);
export type EnvironmentSyncTransferStep = typeof TRANSFER_STEPS extends Set<infer T> ? T : never;
const TRANSFER_FAILURE_KINDS = new Set([
  "command_failed", "download_failed", "download_missing", "unsafe_archive",
  "listing_timeout", "listing_entry_limit", "listing_byte_limit", "listing_line_limit", "listing_stderr_limit",
] as const);
export type EnvironmentSyncTransferFailureKind = typeof TRANSFER_FAILURE_KINDS extends Set<infer T> ? T : never;
interface Capture {
  active: boolean;
  sequence: number;
  errors: WeakMap<object, { sequence: number; diagnostic: PluginEnvironmentSyncErrorDiagnostic }>;
}
const capture = new AsyncLocalStorage<Capture>();

/** Scope evidence to one outbound RPC, including its error serialization. */
export async function withEnvironmentSyncErrorCapture<T>(operation: () => Promise<T>): Promise<T> {
  const scope: Capture = { active: true, sequence: 0, errors: new WeakMap() };
  return capture.run(scope, async () => {
    try { return await operation(); }
    finally { scope.active = false; }
  });
}

/** Producer-owned evidence only; never mutate, wrap, or retain a raw cause. */
export function recordEnvironmentSyncError<T>(error: T, diagnostic: Partial<PluginEnvironmentSyncErrorDiagnostic>): T {
  const scope = capture.getStore();
  const safe = sanitize(diagnostic);
  if (scope?.active && error && typeof error === "object") {
    if (safe) scope.errors.set(error, { sequence: ++scope.sequence, diagnostic: safe });
    else scope.errors.delete(error);
  }
  return error;
}

/** A nested failing stage wins; a later attempt gets fresh attribution. */
export async function withEnvironmentSyncTransferStep<T>(step: EnvironmentSyncTransferStep, operation: () => Promise<T>): Promise<T> {
  const scope = capture.getStore();
  if (!scope?.active || !TRANSFER_STEPS.has(step)) return await operation();
  const started = scope.sequence;
  try { return await operation(); }
  catch (error) {
    if (scope.active && error && typeof error === "object") {
      const saved = scope.errors.get(error);
      const diagnostic = saved && saved.sequence > started ? saved.diagnostic : { errorCode: "unknown" };
      scope.errors.set(error, {
        sequence: ++scope.sequence, diagnostic: { ...diagnostic, transferStep: diagnostic.transferStep ?? step },
      });
    }
    throw error;
  }
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
  const step = field(value, "transferStep");
  const kind = field(value, "transferFailureKind");
  const transferStep = typeof step === "string" && TRANSFER_STEPS.has(step as EnvironmentSyncTransferStep) ? step as EnvironmentSyncTransferStep : undefined;
  const transferFailureKind = typeof kind === "string" && TRANSFER_FAILURE_KINDS.has(kind as EnvironmentSyncTransferFailureKind) ? kind as EnvironmentSyncTransferFailureKind : undefined;
  if (errorCode === "unknown" && httpStatus === undefined && exitCode === undefined && !transferStep && !transferFailureKind) return undefined;
  return { errorCode, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(exitCode !== undefined ? { exitCode } : {}),
    ...(transferStep ? { transferStep } : {}), ...(transferFailureKind ? { transferFailureKind } : {}),
  };
}

/** Capture known codes and numbers, never arbitrary error data, text, or names. */
function captureDiagnostic(error: unknown): PluginEnvironmentSyncErrorDiagnostic | undefined {
  const diagnostic: PluginEnvironmentSyncErrorDiagnostic = { errorCode: "unknown" };
  const scope = capture.getStore();
  if (scope?.active && error && typeof error === "object") {
    Object.assign(diagnostic, scope.errors.get(error)?.diagnostic);
  }
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
  return sanitize(diagnostic);
}

export function environmentSyncErrorData(error: unknown): unknown {
  const diagnostic = captureDiagnostic(error);
  return diagnostic ? { schema: SCHEMA, diagnostic } : undefined;
}

/** Retain bounded evidence across an existing wrapper, without adding a raw cause. */
export function preserveEnvironmentSyncErrorDiagnostic<T>(wrapper: T, source: unknown): T {
  const diagnostic = captureDiagnostic(source);
  return recordEnvironmentSyncError(wrapper, diagnostic ?? { errorCode: "unknown" });
}

/** Revalidate the worker envelope before adapting it into host-only diagnostics. */
export function readEnvironmentSyncErrorDiagnostic(error: unknown): PluginEnvironmentSyncErrorDiagnostic | undefined {
  const data = field(error, "data");
  return field(data, "schema") === SCHEMA ? sanitize(field(data, "diagnostic")) : undefined;
}
