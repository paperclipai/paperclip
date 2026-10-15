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
export interface NativeTurnFailureDiagnostic {
  provider: "codex";
  category: "turn_failed";
  /** A known `CodexErrorInfo` kind, `unrecognized`, or `absent`. */
  codexErrorInfo: string;
  httpStatus?: number;
  /** A known runner-issued failure code, or `unrecognized` for any other code. */
  runnerFailureCode?: string;
}

function httpStatusField(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? { httpStatus: value } : {};
}

function runnerFailureCodeField(value: unknown) {
  if (typeof value !== "string") return {};
  return { runnerFailureCode: NATIVE_TURN_FAILURE_RUNNER_CODES.has(value) ? value : "unrecognized" };
}

function codexErrorInfoFields(value: unknown): Pick<NativeTurnFailureDiagnostic, "codexErrorInfo" | "httpStatus"> {
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
      if (provider.kind !== "codex" ||
          event.sourceKind !== "runner" || event.eventType !== "turn.failed" || !event.turnId) return;
      const payload = record(event.payload);
      const failure = record(payload.error);
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
