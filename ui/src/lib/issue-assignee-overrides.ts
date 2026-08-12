export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
]);

export type IssueModelLane = "primary" | "cheap" | "custom";

export interface BuildAssigneeAdapterOverridesInput {
  adapterType: string | null | undefined;
  lane: IssueModelLane;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
}

/**
 * Build the `assigneeAdapterOverrides` payload sent to the issue create API.
 *
 * Lane semantics:
 * - "primary" → no overrides, runs on the agent's primary model.
 * - "cheap"   → `modelProfile: "cheap"` only; the runtime resolves the actual
 *               adapter config from the agent's runtimeConfig + adapter default.
 * - "custom"  → preserves the legacy explicit override path
 *               (`adapterConfig.model`, thinking effort, chrome).
 */
export function buildAssigneeAdapterOverrides(
  input: BuildAssigneeAdapterOverridesInput,
): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  if (input.lane === "primary") {
    return null;
  }

  if (input.lane === "cheap") {
    return { modelProfile: "cheap" };
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (adapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (adapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    }
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  if (Object.keys(adapterConfig).length === 0) return null;
  return { adapterConfig };
}
