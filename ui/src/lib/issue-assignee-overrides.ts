export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
]);

import { MODEL_PROFILE_KEYS, type ModelProfileKey } from "@paperclipai/shared";

export type IssueModelLane = "primary" | ModelProfileKey | "custom";

export function isProfileLane(lane: IssueModelLane): lane is ModelProfileKey {
  return (MODEL_PROFILE_KEYS as readonly string[]).includes(lane);
}

export function profileLaneFromOverrides(modelProfile: unknown): ModelProfileKey | null {
  return typeof modelProfile === "string" && (MODEL_PROFILE_KEYS as readonly string[]).includes(modelProfile)
    ? (modelProfile as ModelProfileKey)
    : null;
}

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
 * - profile lanes ("cheap", "standard", "premium", "flagship") → `modelProfile`
 *               only; the runtime resolves the actual adapter config from the
 *               agent's runtimeConfig + adapter default.
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

  if (isProfileLane(input.lane)) {
    return { modelProfile: input.lane };
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
