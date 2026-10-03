import type { heartbeatRuns } from "@paperclipai/db";
import { readRunCancellation } from "./run-cancellation.js";
import { WORKSPACE_RESTORE_FAILURE_CODES } from "@paperclipai/shared";
import { redactDiagnosticText } from "@paperclipai/adapter-utils/command-redaction";
import { sanitizeWorkspaceRestoreDiagnostic } from "@paperclipai/adapter-utils/workspace-restore-diagnostics";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Context = Record<string, string | number | boolean>;

export interface RunFailureReportOptions {
  /** The caught exception, before callers flatten it to a message. */
  error?: unknown;
  /** Structured adapter error metadata; only known diagnostic keys are read. */
  adapterErrorMeta?: unknown;
  phase?: "setup" | "execute";
  /** Runtime-only values to redact; never included in the captured event. */
  secretValues?: readonly string[];
}

export interface RunFailureException {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export interface RunFailureDiagnostics {
  execution: Context;
  adapter: Context;
  provider: Context;
  exceptions: RunFailureException[];
  truncatedFields: string[];
}

function read(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function scalars(value: unknown, fields: readonly string[]): Context {
  const result: Context = {};
  for (const field of fields) {
    const entry = read(value, field);
    if (
      typeof entry === "string" || typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) result[field] = entry;
  }
  return result;
}

// Unknown inherited values may contain credentials under arbitrary names.
// Explicitly configured values remain private, including overrides of these keys.
const PUBLIC_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG",
  "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "NODE_ENV",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "PWD", "OLDPWD", "INIT_CWD", "SHLVL", "_", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM",
  "NPM_LIFECYCLE_EVENT", "NPM_COMMAND", "NPM_EXEC_PATH", "NPM_EXECPATH", "NPM_NODE_EXECPATH",
  "NPM_PACKAGE_NAME", "NPM_PACKAGE_VERSION", "NPM_PACKAGE_JSON", "NPM_CONFIG_USER_AGENT",
  "XPC_SERVICE_NAME", "VITEST_POOL_ID", "VITEST_WORKER_ID",
  "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID",
]);
const PUBLIC_BOOLEAN_ENV_KEYS = new Set([
  "OPENCODE_ALLOW_ALL_MODELS", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_GENAI_USE_GCA",
  "CI", "NO_COLOR", "FORCE_COLOR",
  "VITEST", "MALLOCNANOZONE", "CODEX_CI", "CODEX_SHELL", "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE",
  "DEV", "PROD", "SSR", "PAPERCLIP_REQUIRE_SENTRY_TEST_SDK",
  "PAPERCLIP_DB_BACKUP_ENABLED", "PAPERCLIP_AUTH_DISABLE_SIGN_UP", "PAPERCLIP_ENABLE_COMPANY_DELETION",
  "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "PAPERCLIP_SECRETS_STRICT_MODE",
  "SERVE_UI", "PAPERCLIP_UI_DEV_MIDDLEWARE", "HEARTBEAT_SCHEDULER_ENABLED", "PAPERCLIP_ANNOUNCEMENTS_ENABLED",
  "GITHUB_ACTIONS", "GITHUB_REF_PROTECTED", "RUNNER_DEBUG", "ACTIONS_RUNNER_DEBUG", "ACTIONS_STEP_DEBUG",
]);
const PUBLIC_NUMBER_ENV_KEYS = new Set([
  "PORT", "PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES", "PAPERCLIP_DB_BACKUP_RETENTION_DAYS",
  "PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "HEARTBEAT_SCHEDULER_INTERVAL_MS",
  "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_NUMBER", "GITHUB_RUN_ID", "GITHUB_RETENTION_DAYS",
]);

/** Include declared bindings and unknown values, not just credential-like keys. */
export function collectRunFailureSecretValues(
  env: unknown, secretKeys: Iterable<string> = [], inherited = false,
): string[] {
  if (!env || typeof env !== "object") return [];
  const strings = Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
  const declared = new Set(secretKeys);
  const values: string[] = [];
  for (const [key, value] of Object.entries(strings)) {
    if (!value) continue;
    const publicSetting = (inherited && (
      PUBLIC_ENV_KEYS.has(key.toUpperCase()) ||
      (PUBLIC_NUMBER_ENV_KEYS.has(key.toUpperCase()) && /^\d+$/.test(value)) ||
      (key === "BASE_URL" && value === "/") ||
      (key === "MODE" && /^(?:test|development|production)$/.test(value))
    )) ||
      (PUBLIC_BOOLEAN_ENV_KEYS.has(key.toUpperCase()) && /^(?:0|1|true|false)$/i.test(value));
    if (declared.has(key) || !publicSetting) values.push(value);
    try {
      const password = new URL(value).password;
      if (password) values.push(value, password, decodeURIComponent(password));
    } catch { /* ordinary environment values are not URLs */ }
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** Redact literal, JSON-escaped and URI-encoded forms without rewriting markers. */
export function redactRunFailureSecretValues<T>(input: T, values: readonly string[]): T {
  const forms = [...new Set(values.filter(Boolean).flatMap((value) => {
    const forms = [value, JSON.stringify(value).slice(1, -1)];
    try { forms.push(encodeURIComponent(value)); } catch { /* malformed Unicode */ }
    return forms;
  }))].sort((a, b) => b.length - a.length);
  if (forms.length === 0) return input;
  const pattern = new RegExp(forms.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, () => REDACTED_EVENT_VALUE);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    }
    return value;
  };
  return redact(input) as T;
}

/** Snapshot only diagnostics. Never walk a request, response, config or prompt. */
export function collectRunFailureDiagnostics(run: Run, options: RunFailureReportOptions): RunFailureDiagnostics {
  const execution = scalars(run, [
    "runtimeMode", "executionStage", "nativePhase", "driverKind", "driverVersion",
  ]);
  if (options.phase) execution.failurePhase = options.phase;
  if (run.startedAt && run.finishedAt) {
    const durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
    if (Number.isFinite(durationMs) && durationMs >= 0) execution.durationMs = durationMs;
  }
  const result = run.resultJson;
  const cancellation = readRunCancellation(result);
  if (cancellation) {
    execution.cancellationSource = cancellation.source;
    execution.cancellationExpected = cancellation.expected;
    execution.cancellationInitiatorType = cancellation.initiator.type;
  } else if (run.status === "cancelled") {
    execution.cancellationSource = "unknown";
    execution.cancellationExpected = false;
  }
  Object.assign(execution, scalars(result, [
    "mode", "stopReason", "timeoutFired", "timeoutSource", "timeoutConfigured",
    "effectiveTimeoutSec", "errorFamily",
  ]));
  for (const field of ["acpLastEventAgeMs", "acpObservedEventCount", "acpPendingToolCount"]) {
    const value = read(result, field);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) execution[field] = value;
  }
  const toolInventoryComplete = read(result, "acpToolInventoryComplete");
  if (typeof toolInventoryComplete === "boolean") execution.acpToolInventoryComplete = toolInventoryComplete;
  const restoreFailure = read(result, "workspaceRestoreFailure");
  const restoreCode = WORKSPACE_RESTORE_FAILURE_CODES.find((code) => code === restoreFailure);
  if (restoreCode) {
    execution.workspaceRestoreFailure = restoreCode;
    const diagnostic = sanitizeWorkspaceRestoreDiagnostic(read(result, "workspaceRestoreDiagnostic"));
    if (diagnostic) {
      execution.workspaceRestorePhase = diagnostic.phase;
      execution.workspaceRestoreErrorCode = diagnostic.errorCode;
      if (diagnostic.step) execution.workspaceRestoreStep = diagnostic.step;
      if (diagnostic.httpStatus !== undefined) execution.workspaceRestoreHttpStatus = diagnostic.httpStatus;
      if (diagnostic.exitCode !== undefined) execution.workspaceRestoreExitCode = diagnostic.exitCode;
    }
  }
  const adapter = scalars(options.adapterErrorMeta, [
    "category", "phase", "errorName", "acpCode", "causeMessage", "retryable",
    "stackPreview", "status", "statusCode", "requestId",
  ]);
  const provider = scalars(read(result, "terminalSessionFailure"), ["category", "title", "details"]);
  const truncatedFields: string[] = [];
  const providerTruncation = read(read(result, "terminalSessionFailure"), "truncatedFields");
  if (Array.isArray(providerTruncation)) {
    for (const field of ["title", "details"]) {
      if (providerTruncation.includes(field)) truncatedFields.push(`provider.${field}`);
    }
  }
  const exceptions: RunFailureException[] = [];
  const seen = new Set<unknown>();
  let error = options.error;
  while (error !== undefined && error !== null && exceptions.length < 4) {
    if (seen.has(error)) {
      truncatedFields.push("exceptions.cycle");
      break;
    }
    seen.add(error);
    if (typeof error === "string") {
      exceptions.push({ message: error });
      error = undefined;
      break;
    }
    if (typeof error !== "object") break;
    if (execution.restoreLockOwnerState === undefined && read(error, "code") === "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT") {
      const lock = read(error, "workspaceRestoreLock");
      const operation = read(lock, "operation");
      if (["agent_directory_prepare", "agent_directory_release", "agent_directory_collect", "agent_directory_checkpoint", "agent_directory_handoff"].some(value => value === operation)) {
        execution.restoreLockOperation = operation as string;
      }
      const ownerState = read(lock, "ownerState");
      if (["alive", "dead", "unknown", "missing", "invalid"].some(value => value === ownerState)) {
        execution.restoreLockOwnerState = ownerState as string;
      }
      for (const field of ["knownLocalHolder", "ownerSameProcess", "ownerPredatesProcess"]) {
        const value = read(lock, field);
        if (typeof value === "boolean") execution[`restoreLock${field[0]!.toUpperCase()}${field.slice(1)}`] = value;
      }
      for (const field of ["ownerAgeMs", "waitMs"]) {
        const value = read(lock, field);
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 7 * 24 * 60 * 60 * 1000) {
          execution[`restoreLock${field[0]!.toUpperCase()}${field.slice(1)}`] = value;
        }
      }
    }
    const entry: RunFailureException = {};
    for (const field of ["name", "message", "stack", "code"] as const) {
      const value = read(error, field);
      if (typeof value === "string") entry[field] = value;
      else if (field === "code" && typeof value === "number" && Number.isFinite(value)) entry.code = String(value);
    }
    const status = read(error, "status") ?? read(error, "statusCode");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
    const requestId = read(error, "requestId") ?? read(error, "request_id");
    if (typeof requestId === "string") entry.requestId = requestId;
    if (Object.keys(entry).length > 0) exceptions.push(entry);
    else break;
    error = read(error, "cause");
  }
  if (error !== undefined && error !== null && exceptions.length === 4) truncatedFields.push("exceptions.depth");
  return { execution, adapter, provider, exceptions, truncatedFields };
}

/** Redact complete values before cutting, including credentials across a cut. */
export function sanitizeRunFailureText(input: string, limit: number): string {
  const normalized = input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[\ud800-\udfff]/gu, "\ufffd");
  const clean = redactSensitiveText(redactDiagnosticText(redactCurrentUserText(normalized)));
  if (clean.length <= limit) return clean;
  const suffix = "\n[truncated]";
  let end = limit - suffix.length;
  if ((clean.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return clean.slice(0, end) + suffix;
}

/** Called after the run's registered secret values have also been removed. */
export function sanitizeRunFailureDiagnostics(raw: RunFailureDiagnostics): RunFailureDiagnostics {
  const truncatedFields = [...raw.truncatedFields];
  const text = (value: string, path: string, limit: number) => {
    const sanitized = sanitizeRunFailureText(value, limit);
    if (sanitized.endsWith("\n[truncated]")) truncatedFields.push(path);
    return sanitized;
  };
  const context = (value: Context, prefix: string, limits: Record<string, number> = {}): Context =>
    Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
      typeof value === "string" ? text(value, `${prefix}.${key}`, limits[key] ?? 200) : value,
    ]));
  return {
    execution: context(raw.execution, "execution"),
    adapter: context(raw.adapter, "adapter", { causeMessage: 2048, stackPreview: 8192 }),
    provider: context(raw.provider, "provider", { title: 4096, details: 12288 }),
    exceptions: raw.exceptions.map((entry, i) => context(entry as Context, `exceptions.${i}`, { message: 2048, stack: 8192 })),
    truncatedFields: [...new Set(truncatedFields)],
  };
}
