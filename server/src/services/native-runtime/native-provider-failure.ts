import type { PrpEvent, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";

export const NATIVE_MODEL_REJECTION_MESSAGE =
  "The selected model is not supported by the current ChatGPT connection. Choose a supported model or a compatible AI connection.";

export const NATIVE_PROVIDER_OVERLOADED_MESSAGE =
  "Selected model is at capacity. Please try a different model.";
export const NATIVE_PROVIDER_OVERLOADED_CODE = "native_provider_overloaded";
export const NATIVE_PROVIDER_CAPACITY_MAX_RETRIES = 2;
export const NATIVE_PROVIDER_OVERLOADED_DIAGNOSTIC = {
  provider: "codex",
  category: "server_overloaded",
} as const;

export const NATIVE_MODEL_REJECTION_DIAGNOSTIC = {
  provider: "codex",
  category: "model_auth_incompatible",
  status: 400,
  authMode: "chatgpt",
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Reconstruct only the closed diagnostic vocabulary, never provider text. */
export function readNativeModelRejectionDiagnostic(value: unknown) {
  try {
    const entry = record(value);
    return Object.entries(NATIVE_MODEL_REJECTION_DIAGNOSTIC).every(([key, expected]) => entry[key] === expected)
      ? { ...NATIVE_MODEL_REJECTION_DIAGNOSTIC }
      : null;
  } catch { return null; }
}

/**
 * Codex `CodexErrorInfo` variants. Unit variants arrive as strings; HTTP
 * variants arrive as one-key objects that can carry `httpStatusCode`.
 */
const CODEX_ERROR_INFO_KINDS: ReadonlySet<string> = new Set([
  "contextWindowExceeded", "usageLimitExceeded", "serverOverloaded", "httpConnectionFailed",
  "responseStreamConnectionFailed", "internalServerError", "unauthorized", "badRequest",
  "threadRollbackFailed", "sandboxError", "responseStreamDisconnected",
  "responseTooManyFailedAttempts", "other",
]);
/**
 * `error.code` values the runner itself writes on a failed Codex turn: the
 * Codex driver's `failProtocol` callers and runnerd's Codex backend. A provider
 * error object can also carry `code`, so any other value is `unrecognized`.
 */
const NATIVE_TURN_FAILURE_RUNNER_CODES: ReadonlySet<string> = new Set([
  "thread_binding_mismatch", "turn_binding_mismatch", "turn_start_mismatch", "tool_binding_mismatch",
  "runtime_request_binding_mismatch", "runtime_request_duplicate", "runtime_request_recovery_failed",
  "notification_transport_failed", "provider_event_type_invalid", "invalid_semantic_result",
  "conflicting_semantic_result", "conflicting_turn_terminal", "invalid_spawn_lineage",
  "provider_descendant_capacity_exhausted", "provider_terminal_error_missing", "provider_turn_lost_on_restore",
]);

/**
 * Closed vocabulary for a failed Codex turn that no classifier above claims.
 * It explains generic `Native session failed` reports without provider text.
 */
export interface NativeCodexTurnFailureDiagnostic {
  provider: "codex";
  category: "turn_failed";
  /** A known `CodexErrorInfo` kind, `unrecognized`, or `absent`. */
  codexErrorInfo: string;
  httpStatus?: number;
  /** A known runner-issued failure code, or `unrecognized` for any other code. */
  runnerFailureCode?: string;
}

/**
 * `error.code` values the OpenCode driver writes when it fails a turn itself.
 * Other OpenCode failures carry provider error objects and stay `unrecognized`.
 */
const OPENCODE_TURN_FAILURE_RUNNER_CODES: ReadonlySet<string> = new Set([
  "opencode_server_exited", "opencode_event_stream_lost", "provider_terminal_error_missing",
]);
const OPENCODE_STREAM_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "server_exited", "connection_failed", "http_error", "stream_closed", "stream_error",
]);
const OPENCODE_CONNECTION_ERRORS: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "unrecognized",
]);
/** POSIX, Linux and macOS signal names; any other `signal` value is dropped. */
const OPENCODE_EXIT_SIGNALS: ReadonlySet<string> = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT", "SIGBUS", "SIGEMT", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD",
  "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM",
  "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL", "SIGPWR", "SIGINFO", "SIGLOST", "SIGSYS", "SIGUNUSED",
]);

/** Closed vocabulary for a failed OpenCode turn, including a lost `opencode serve`. */
export interface NativeOpenCodeTurnFailureDiagnostic {
  provider: "opencode";
  category: "turn_failed";
  /** A known runner-issued failure code, or `unrecognized` for any other code. */
  runnerFailureCode?: string;
  /** How the driver lost its event stream, when it failed the turn itself. */
  streamFailure?: string;
  exitCode?: number;
  signal?: string;
  connectionError?: string;
  httpStatus?: number;
}

export type NativeTurnFailureDiagnostic = NativeCodexTurnFailureDiagnostic | NativeOpenCodeTurnFailureDiagnostic;

function httpStatusField(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? { httpStatus: value } : {};
}

function runnerFailureCodeField(value: unknown, codes: ReadonlySet<string> = NATIVE_TURN_FAILURE_RUNNER_CODES) {
  if (typeof value !== "string") return {};
  return { runnerFailureCode: codes.has(value) ? value : "unrecognized" };
}

function openCodeStreamFailureFields(value: unknown): Omit<NativeOpenCodeTurnFailureDiagnostic, "provider" | "category" | "runnerFailureCode"> {
  const entry = record(value);
  const kind = entry.kind ?? entry.streamFailure;
  if (typeof kind !== "string" || !OPENCODE_STREAM_FAILURE_KINDS.has(kind)) return {};
  const { exitCode, signal, connectionError } = entry;
  return {
    streamFailure: kind,
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? { exitCode } : {}),
    ...(typeof signal === "string" && OPENCODE_EXIT_SIGNALS.has(signal) ? { signal } : {}),
    ...(typeof connectionError === "string" && OPENCODE_CONNECTION_ERRORS.has(connectionError) ? { connectionError } : {}),
    ...httpStatusField(entry.httpStatus),
  };
}

function openCodeTurnFailure(failure: Record<string, unknown>): NativeOpenCodeTurnFailureDiagnostic {
  return {
    provider: "opencode",
    category: "turn_failed",
    ...runnerFailureCodeField(failure.code, OPENCODE_TURN_FAILURE_RUNNER_CODES),
    ...openCodeStreamFailureFields(failure.opencodeFailure),
  };
}

function codexErrorInfoFields(value: unknown): Pick<NativeCodexTurnFailureDiagnostic, "codexErrorInfo" | "httpStatus"> {
  if (value === undefined || value === null) return { codexErrorInfo: "absent" };
  if (typeof value === "string") return { codexErrorInfo: CODEX_ERROR_INFO_KINDS.has(value) ? value : "unrecognized" };
  const entry = record(value);
  const keys = Object.keys(entry);
  if (keys.length !== 1 || !CODEX_ERROR_INFO_KINDS.has(keys[0]!)) return { codexErrorInfo: "unrecognized" };
  return { codexErrorInfo: keys[0]!, ...httpStatusField(record(entry[keys[0]!]).httpStatusCode) };
}

/** Rebuild a persisted turn-failure diagnostic from its closed vocabulary only. */
export function readNativeTurnFailureDiagnostic(value: unknown): NativeTurnFailureDiagnostic | null {
  try {
    const entry = record(value);
    if (entry.provider === "opencode") {
      if (entry.category !== "turn_failed") return null;
      return {
        provider: "opencode",
        category: "turn_failed",
        ...runnerFailureCodeField(entry.runnerFailureCode, OPENCODE_TURN_FAILURE_RUNNER_CODES),
        ...openCodeStreamFailureFields(entry),
      };
    }
    const kind = entry.codexErrorInfo;
    if (entry.provider !== "codex" || entry.category !== "turn_failed" || typeof kind !== "string" ||
        (kind !== "absent" && kind !== "unrecognized" && !CODEX_ERROR_INFO_KINDS.has(kind))) return null;
    return {
      provider: "codex",
      category: "turn_failed",
      codexErrorInfo: kind,
      ...httpStatusField(entry.httpStatus),
      ...runnerFailureCodeField(entry.runnerFailureCode),
    };
  } catch { return null; }
}

/** Observe only events accepted by the bound control-plane persistence port. */
export function createNativeProviderFailureObservation(provider: { kind: string; model?: string | null }) {
  let rejectedTurnId: string | null = null;
  let overloadedTurnId: string | null = null;
  const failedTurns = new Map<string, NativeTurnFailureDiagnostic>();
  return {
    observe(event: PrpEvent) {
      if ((provider.kind !== "codex" && provider.kind !== "opencode") ||
          event.sourceKind !== "runner" || event.eventType !== "turn.failed" || !event.turnId) return;
      const payload = record(event.payload);
      const failure = record(payload.error);
      if (provider.kind === "opencode") {
        // OpenCode has no classifier above, so every failed turn is diagnosed.
        if (payload.status === "failed") failedTurns.set(event.turnId, openCodeTurnFailure(failure));
        return;
      }
      if (payload.status === "failed") {
        failedTurns.set(event.turnId, {
          provider: "codex",
          category: "turn_failed",
          ...codexErrorInfoFields(failure.codexErrorInfo),
          ...runnerFailureCodeField(failure.code),
        });
      }
      if (payload.status === "failed" && failure.codexErrorInfo === "serverOverloaded") {
        overloadedTurnId = event.turnId;
        return;
      }
      if (!provider.model || payload.status !== "failed" || payload.recoverable === true || failure.recoverable === true ||
          typeof failure.message !== "string" || failure.message.length > 4_096) return;
      let response: Record<string, unknown>;
      try { response = record(JSON.parse(failure.message)); } catch { return; }
      const error = record(response.error);
      // This is a provider terminal envelope, not text emitted by a tool or an
      // agent. Bind the exact rejection to the configured model without storing
      // its name or the response. Unknown provider errors retain their behavior.
      if (response.type !== "error" || response.status !== 400 || error.type !== "invalid_request_error" ||
          error.message !== `The '${provider.model}' model is not supported when using Codex with a ChatGPT account.`) return;
      rejectedTurnId = event.turnId;
    },
    forTerminal(turnId: string | null | undefined, terminal: PrpTerminalState) {
      if (!turnId || terminal.turnTerminalState !== "failed" || terminal.runTerminalState !== "failed") return null;
      if (turnId === overloadedTurnId) return {
        errorCode: NATIVE_PROVIDER_OVERLOADED_CODE,
        errorMessage: NATIVE_PROVIDER_OVERLOADED_MESSAGE,
        diagnostic: { ...NATIVE_PROVIDER_OVERLOADED_DIAGNOSTIC },
      };
      if (turnId !== rejectedTurnId) return null;
      return {
        errorCode: "native_provider_model_rejected" as const,
        errorMessage: NATIVE_MODEL_REJECTION_MESSAGE,
        diagnostic: { ...NATIVE_MODEL_REJECTION_DIAGNOSTIC },
      };
    },
    /** Diagnostics only: the failed turn that `forTerminal` did not classify. */
    unclassifiedTurnFailure(turnId: string | null | undefined, terminal: PrpTerminalState) {
      if (!turnId || terminal.turnTerminalState !== "failed" || terminal.runTerminalState !== "failed" ||
          turnId === overloadedTurnId || turnId === rejectedTurnId) return null;
      const diagnostic = failedTurns.get(turnId);
      return diagnostic ? { ...diagnostic } : null;
    },
  };
}
