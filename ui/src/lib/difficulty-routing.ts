import {
  DIFFICULTY_TIERS,
  difficultyRoutingConfigSchema,
  type DifficultyEscalationReason,
  type DifficultyRoutingConfig,
  type DifficultyTier,
  type DifficultyTierSetting,
  type IssueDifficultyRouting,
} from "@paperclipai/shared";

export const DIFFICULTY_TIER_LABELS: Record<DifficultyTier, string> = {
  L1: "Simple",
  L2: "Medium",
  L3: "Hard",
};

export const DIFFICULTY_ESCALATION_REASON_LABELS: Record<DifficultyEscalationReason, string> = {
  run_failed: "previous run failed",
  changes_requested: "changes requested",
  reopened: "reopened by a user",
};

export function readDifficultyRoutingDraft(value: unknown): DifficultyRoutingConfig {
  const parsed = difficultyRoutingConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : { enabled: false, tiers: {} };
}

/** A tier row, or the escalation row used after a tier did not solve the task. */
export type DifficultySettingRow = DifficultyTier | "escalation";

export function setDifficultyTierSetting(
  config: DifficultyRoutingConfig,
  tier: DifficultySettingRow,
  patch: Partial<Record<keyof DifficultyTierSetting, string>>,
): DifficultyRoutingConfig {
  const merged = { ...(tier === "escalation" ? config.escalation : config.tiers[tier]), ...patch };
  const setting: DifficultyTierSetting = {};
  if (merged.model?.trim()) setting.model = merged.model.trim();
  if (merged.effort?.trim()) setting.effort = merged.effort.trim();
  if (tier === "escalation") {
    const { escalation: _previous, ...rest } = config;
    return Object.keys(setting).length > 0 ? { ...rest, escalation: setting } : rest;
  }
  const tiers = { ...config.tiers };
  if (Object.keys(setting).length > 0) tiers[tier] = setting;
  else delete tiers[tier];
  return { ...config, tiers };
}

function sameDifficultyRouting(a: DifficultyRoutingConfig, b: DifficultyRoutingConfig): boolean {
  return a.enabled === b.enabled && DIFFICULTY_TIERS.every((tier) =>
    a.tiers[tier]?.model === b.tiers[tier]?.model && a.tiers[tier]?.effort === b.tiers[tier]?.effort)
    && a.escalation?.model === b.escalation?.model && a.escalation?.effort === b.escalation?.effort;
}

export function runtimeConfigWithDifficultyRouting(
  saved: Record<string, unknown>,
  draft: Record<string, unknown> | undefined,
  next: DifficultyRoutingConfig,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...saved, ...draft, aiConnection: (draft ?? saved).aiConnection };
  if (!sameDifficultyRouting(readDifficultyRoutingDraft(saved.difficultyRouting), next)) merged.difficultyRouting = next;
  else if ("difficultyRouting" in saved) merged.difficultyRouting = saved.difficultyRouting;
  else delete merged.difficultyRouting;
  return merged;
}

export function agentUsesDifficultyRouting(runtimeConfig: Record<string, unknown> | null | undefined): boolean {
  return readDifficultyRoutingDraft(runtimeConfig?.difficultyRouting).enabled;
}

export function formatIssueDifficultyRouting(routing: IssueDifficultyRouting | null | undefined): string {
  if (!routing) return "Auto (decided at first run)";
  const parts = [`${routing.source === "manual" ? "Manual" : "Auto"}: ${routing.tier}`];
  parts.push(routing.model ?? "agent default model");
  if (routing.effort) parts.push(routing.effort);
  if (routing.confidence !== null) parts.push(`${Math.round(routing.confidence * 100)}% confidence`);
  if (routing.escalation) {
    const step = routing.escalation.step === "escalation" ? "escalated" : `escalated from ${routing.escalation.fromTier}`;
    parts.push(`${step}: ${DIFFICULTY_ESCALATION_REASON_LABELS[routing.escalation.reason]}`);
  }
  return parts.join(" · ");
}
