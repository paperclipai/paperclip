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

/** Observe only events accepted by the bound control-plane persistence port. */
export function createNativeProviderFailureObservation(provider: { kind: string; model?: string | null }) {
  let rejectedTurnId: string | null = null;
  let overloadedTurnId: string | null = null;
  return {
    observe(event: PrpEvent) {
      if (provider.kind !== "codex" ||
          event.sourceKind !== "runner" || event.eventType !== "turn.failed" || !event.turnId) return;
      const payload = record(event.payload);
      const failure = record(payload.error);
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
  };
}
