/**
 * Canonical model/effort mapping shared across all adapters.
 *
 * Maps canonical model IDs to adapter-specific model IDs (aliases), and maps
 * canonical effort levels to the adapter-specific (field, value) they require.
 *
 * Used to intelligently translate model + effort when switching adapter types
 * so settings are preserved rather than reset to defaults.
 */

export type AdapterType =
  | "claude_local"
  | "codex_local"
  | "copilot_cli"
  | "cursor"
  | "gemini_local"
  | "opencode_local"
  | "oz_local"
  | "pi_local"
  | "openclaw_gateway";

export interface CanonicalModel {
  label: string;
  /** Per-adapter model ID. First element of an array is the preferred alias. */
  adapters: Partial<Record<AdapterType, string | string[]>>;
}

export interface CanonicalEffortLevel {
  label: string;
  /** Per-adapter effort configuration. Adapters absent don't support this level. */
  adapters: Partial<Record<AdapterType, { field: string; value: string }>>;
}

/**
 * Canonical model catalogue. Key = canonical model ID.
 * Ordered roughly from most capable to least within each family.
 *
 * Note: cursor's thinking models (e.g. "opus-4.6-thinking") encode effort in
 * the model ID — they are handled separately via CURSOR_THINKING_MODELS.
 */
export const CANONICAL_MODELS: Record<string, CanonicalModel> = {
  // ── Claude ──────────────────────────────────────────────────────────────
  "claude-opus-4.6": {
    label: "Claude Opus 4.6",
    adapters: {
      claude_local: "claude-opus-4-6",
      copilot_cli: "claude-opus-4.6",
      cursor: "opus-4.6",
    },
  },
  "claude-opus-4.6-fast": {
    label: "Claude Opus 4.6 (fast)",
    adapters: {
      copilot_cli: "claude-opus-4.6-fast",
    },
  },
  "claude-sonnet-4.6": {
    label: "Claude Sonnet 4.6",
    adapters: {
      claude_local: "claude-sonnet-4-6",
      copilot_cli: "claude-sonnet-4.6",
      cursor: "sonnet-4.6",
    },
  },
  "claude-haiku-4.6": {
    label: "Claude Haiku 4.6",
    adapters: {
      claude_local: "claude-haiku-4-6",
    },
  },
  "claude-opus-4.5": {
    label: "Claude Opus 4.5",
    adapters: {
      copilot_cli: "claude-opus-4.5",
      cursor: "opus-4.5",
    },
  },
  "claude-sonnet-4.5": {
    label: "Claude Sonnet 4.5",
    adapters: {
      claude_local: "claude-sonnet-4-5-20250929",
      copilot_cli: "claude-sonnet-4.5",
      cursor: "sonnet-4.5",
      oz_local: "claude-4-5-sonnet",
    },
  },
  "claude-haiku-4.5": {
    label: "Claude Haiku 4.5",
    adapters: {
      claude_local: "claude-haiku-4-5-20251001",
      copilot_cli: "claude-haiku-4.5",
      oz_local: "claude-4-5-haiku",
    },
  },
  "claude-sonnet-4": {
    label: "Claude Sonnet 4",
    adapters: {
      copilot_cli: "claude-sonnet-4",
    },
  },

  // ── GPT ─────────────────────────────────────────────────────────────────
  "gpt-5.4": {
    label: "GPT-5.4",
    adapters: {
      codex_local: "gpt-5.4",
      copilot_cli: "gpt-5.4",
    },
  },
  "gpt-5.3-codex": {
    label: "GPT-5.3 Codex",
    adapters: {
      codex_local: "gpt-5.3-codex",
      copilot_cli: "gpt-5.3-codex",
      cursor: "gpt-5.3-codex",
    },
  },
  "gpt-5.2-codex": {
    label: "GPT-5.2 Codex",
    adapters: {
      copilot_cli: "gpt-5.2-codex",
      cursor: "gpt-5.2-codex",
    },
  },
  "gpt-5.1-codex-max": {
    label: "GPT-5.1 Codex Max",
    adapters: {
      copilot_cli: "gpt-5.1-codex-max",
      cursor: "gpt-5.1-codex-max",
    },
  },
  "gpt-5.1-codex": {
    label: "GPT-5.1 Codex",
    adapters: {
      copilot_cli: "gpt-5.1-codex",
    },
  },
  "gpt-5.1-codex-mini": {
    label: "GPT-5.1 Codex Mini",
    adapters: {
      copilot_cli: "gpt-5.1-codex-mini",
      cursor: "gpt-5.1-codex-mini",
    },
  },
  "gpt-5.4-mini": {
    label: "GPT-5.4 Mini",
    adapters: {
      copilot_cli: "gpt-5.4-mini",
    },
  },
  "gpt-5-mini": {
    label: "GPT-5 Mini",
    adapters: {
      codex_local: "gpt-5-mini",
      copilot_cli: "gpt-5-mini",
    },
  },
  "gpt-5.2": {
    label: "GPT-5.2",
    adapters: {
      copilot_cli: "gpt-5.2",
      cursor: "gpt-5.2",
    },
  },
  "gpt-5.1": {
    label: "GPT-5.1",
    adapters: {
      copilot_cli: "gpt-5.1",
    },
  },
  "gpt-4.1": {
    label: "GPT-4.1",
    adapters: {
      copilot_cli: "gpt-4.1",
    },
  },
  "gpt-5": {
    label: "GPT-5",
    adapters: {
      codex_local: "gpt-5",
      oz_local: "gpt-5",
    },
  },

  // ── Gemini ───────────────────────────────────────────────────────────────
  "gemini-3-pro": {
    label: "Gemini 3 Pro",
    adapters: {
      copilot_cli: "gemini-3-pro-preview",
      cursor: "gemini-3-pro",
      oz_local: "gemini-3-pro",
    },
  },
  "gemini-2.5-pro": {
    label: "Gemini 2.5 Pro",
    adapters: {
      gemini_local: "gemini-2.5-pro",
      oz_local: "gemini-2.5-pro",
    },
  },
  "gemini-2.5-flash": {
    label: "Gemini 2.5 Flash",
    adapters: {
      gemini_local: "gemini-2.5-flash",
    },
  },
  "gemini-2.5-flash-lite": {
    label: "Gemini 2.5 Flash Lite",
    adapters: {
      gemini_local: "gemini-2.5-flash-lite",
    },
  },
  "gemini-2.0-flash": {
    label: "Gemini 2.0 Flash",
    adapters: {
      gemini_local: "gemini-2.0-flash",
    },
  },
};

/**
 * Cursor model IDs that encode a "high/thinking" effort level in the model name.
 * Key = cursor model ID, value = canonical effort level.
 */
export const CURSOR_THINKING_MODELS: Record<string, string> = {
  "opus-4.6-thinking": "high",
  "opus-4.5-thinking": "high",
  "sonnet-4.6-thinking": "high",
  "sonnet-4.5-thinking": "high",
};

/**
 * Canonical effort levels. Key = canonical effort level ID.
 *
 * Note: cursor's `mode` (plan/ask) is an execution mode — NOT a reasoning effort
 * level — so it is intentionally absent from this map.
 */
export const CANONICAL_EFFORT_LEVELS: Record<string, CanonicalEffortLevel> = {
  low: {
    label: "Low",
    adapters: {
      claude_local: { field: "effort", value: "low" },
      codex_local: { field: "modelReasoningEffort", value: "low" },
      copilot_cli: { field: "reasoningEffort", value: "low" },
      opencode_local: { field: "variant", value: "low" },
      pi_local: { field: "thinking", value: "low" },
    },
  },
  medium: {
    label: "Medium",
    adapters: {
      claude_local: { field: "effort", value: "medium" },
      codex_local: { field: "modelReasoningEffort", value: "medium" },
      copilot_cli: { field: "reasoningEffort", value: "medium" },
      opencode_local: { field: "variant", value: "medium" },
      pi_local: { field: "thinking", value: "medium" },
    },
  },
  high: {
    label: "High",
    adapters: {
      claude_local: { field: "effort", value: "high" },
      codex_local: { field: "modelReasoningEffort", value: "high" },
      copilot_cli: { field: "reasoningEffort", value: "high" },
      opencode_local: { field: "variant", value: "high" },
      pi_local: { field: "thinking", value: "high" },
    },
  },
  xhigh: {
    label: "Extra High",
    adapters: {
      // xhigh is copilot-cli-only; falls back to "high" for other adapters via translateEffort
      copilot_cli: { field: "reasoningEffort", value: "xhigh" },
      pi_local: { field: "thinking", value: "xhigh" },
    },
  },
  minimal: {
    label: "Minimal",
    adapters: {
      codex_local: { field: "modelReasoningEffort", value: "minimal" },
      opencode_local: { field: "variant", value: "minimal" },
      pi_local: { field: "thinking", value: "minimal" },
    },
  },
  max: {
    label: "Max",
    adapters: {
      // max is opencode-only; falls back to "high" for other adapters via translateEffort
      opencode_local: { field: "variant", value: "max" },
    },
  },
  off: {
    label: "Off",
    adapters: {
      pi_local: { field: "thinking", value: "off" },
    },
  },
};

/**
 * Fields that are semantically shared across most local adapters and should be
 * preserved verbatim when switching adapter types (unless already overridden in
 * the overlay by the user).
 */
export const SHARED_ADAPTER_FIELDS = [
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "cwd",
  "env",
  "command",
  "extraArgs",
  "timeoutSec",
  "graceSec",
  "workspaceStrategy",
  "workspaceRuntime",
] as const;

// ── Built-in reverse lookup maps ────────────────────────────────────────────

/** (adapterType + ":" + adapterModelId) → canonicalModelId */
const MODEL_REVERSE = new Map<string, string>();
for (const [canonicalId, cm] of Object.entries(CANONICAL_MODELS)) {
  for (const [adapterType, adapterModel] of Object.entries(cm.adapters)) {
    const ids = Array.isArray(adapterModel) ? adapterModel : [adapterModel];
    for (const id of ids) {
      MODEL_REVERSE.set(`${adapterType}:${id}`, canonicalId);
    }
  }
}

/** (adapterType + ":" + effortValue) → canonicalEffortLevel */
const EFFORT_REVERSE = new Map<string, string>();
for (const [canonicalLevel, ce] of Object.entries(CANONICAL_EFFORT_LEVELS)) {
  for (const [adapterType, effortCfg] of Object.entries(ce.adapters)) {
    EFFORT_REVERSE.set(`${adapterType}:${effortCfg.value}`, canonicalLevel);
  }
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Given a model ID used in a specific adapter, return the canonical model ID.
 * Handles cursor's thinking-suffix models (e.g. "opus-4.6-thinking" → "claude-opus-4.6").
 */
export function resolveCanonicalModel(adapterType: string, modelId: string): string | undefined {
  if (adapterType === "cursor" && CURSOR_THINKING_MODELS[modelId]) {
    // Strip thinking suffix to find the base model canonical ID
    const base = modelId.replace(/-thinking$/, "");
    return MODEL_REVERSE.get(`cursor:${base}`);
  }
  return MODEL_REVERSE.get(`${adapterType}:${modelId}`);
}

/**
 * Given a canonical model ID and target adapter, return the best adapter-specific
 * model ID. When switching TO cursor with a high canonical effort, prefers the
 * `-thinking` variant.
 */
export function translateModel(
  canonicalId: string,
  toAdapter: string,
  canonicalEffort?: string,
): string | undefined {
  const cm = CANONICAL_MODELS[canonicalId];
  if (!cm) return undefined;
  const adapterModel = cm.adapters[toAdapter as AdapterType];
  if (!adapterModel) return undefined;
  const base = Array.isArray(adapterModel) ? adapterModel[0] : adapterModel;

  if (toAdapter === "cursor" && canonicalEffort === "high") {
    const thinkingVariant = `${base}-thinking`;
    if (thinkingVariant in CURSOR_THINKING_MODELS) return thinkingVariant;
  }
  return base;
}

/**
 * Extract the raw effort value from an adapterConfig object, using the correct
 * field name for the given adapter type.
 */
export function getAdapterEffortValue(
  adapterType: string,
  config: Record<string, unknown>,
): string {
  switch (adapterType) {
    case "codex_local":
      return String(config.modelReasoningEffort ?? "");
    case "copilot_cli":
      return String(config.reasoningEffort ?? "");
    case "opencode_local":
      return String(config.variant ?? "");
    case "pi_local":
      return String(config.thinking ?? "");
    // cursor's `mode` (plan/ask) is an execution mode — not a canonical effort level
    default:
      return String(config.effort ?? "");
  }
}

/**
 * Given an adapter type and the raw effort value from its config, return the
 * canonical effort level. Returns undefined for cursor (mode ≠ reasoning effort)
 * or when the value is empty / unrecognised.
 */
export function resolveCanonicalEffort(adapterType: string, effortValue: string): string | undefined {
  // cursor's mode (plan/ask) is NOT a reasoning effort level
  if (adapterType === "cursor" || !effortValue) return undefined;
  return EFFORT_REVERSE.get(`${adapterType}:${effortValue}`);
}

/**
 * Given a canonical effort level and a target adapter, return the adapter-specific
 * { field, value } pair. Falls back to "high" when the exact level isn't supported
 * (e.g. xhigh → high for claude_local, max → high for copilot_cli).
 */
export function translateEffort(
  canonicalLevel: string,
  toAdapter: string,
): { field: string; value: string } | undefined {
  if (!canonicalLevel) return undefined;

  const ce = CANONICAL_EFFORT_LEVELS[canonicalLevel];
  const direct = ce?.adapters[toAdapter as AdapterType];
  if (direct) return direct;

  // Graceful fallback: unsupported extreme levels → high
  if (canonicalLevel === "xhigh" || canonicalLevel === "max") {
    return CANONICAL_EFFORT_LEVELS["high"]?.adapters[toAdapter as AdapterType];
  }

  return undefined;
}
