import { models as codexLocalModels } from "@paperclipai/adapter-codex-local";

export type CompatResult =
  | { available: true }
  | {
      available: false;
      code: "unsupported_model" | "unbound_account" | "adapter_unknown";
      reason: string;
      supportedModels: string[];
    };

// gpt-5.3-codex-spark causes account-level authentication failures in the
// Codex CLI on all accounts. Kept as a runtime denylist even after removal
// from the picker so persisted configs are caught at config-save and wake time.
const CODEX_LOCAL_BLOCKED_MODELS = new Set(["gpt-5.3-codex-spark"]);

function codexLocalSupportedModels(): string[] {
  return codexLocalModels
    .map((m) => m.id)
    .filter((id) => !CODEX_LOCAL_BLOCKED_MODELS.has(id));
}

/**
 * Resolves whether a given model is available for the adapter+account combination.
 *
 * v1: static allowlist for codex_local; permissive default for all other adapters.
 * companyId is reserved for per-account dynamic checks in future adapter implementations.
 */
export function resolveAdapterModelAvailability(
  adapterType: string,
  model: string,
  _companyId: string,
): CompatResult {
  if (adapterType === "codex_local") {
    if (CODEX_LOCAL_BLOCKED_MODELS.has(model)) {
      return {
        available: false,
        code: "unsupported_model",
        reason: `Model "${model}" causes account-level failures in the Codex CLI and is not supported. Choose a supported model.`,
        supportedModels: codexLocalSupportedModels(),
      };
    }
  }
  return { available: true };
}
