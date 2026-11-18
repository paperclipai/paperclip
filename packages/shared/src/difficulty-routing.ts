import { z } from "zod";

export const DIFFICULTY_TIERS = ["L1", "L2", "L3"] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];
export const difficultyTierSchema = z.enum(DIFFICULTY_TIERS);

export const DIFFICULTY_TIER_CRITERIA: Record<DifficultyTier, string> = {
  L1: "Simple: a question, a lookup, a status check, or a small, local edit with an obvious answer",
  L2: "Medium: ordinary coding, writing, or a multi-step task with clear requirements",
  L3: "Hard: architecture or design work, difficult debugging, large changes across many modules, or unclear requirements",
};

const tierSettingSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(64).optional(),
}).strict();
export type DifficultyTierSetting = z.infer<typeof tierSettingSchema>;

export const difficultyRoutingConfigSchema = z.object({
  enabled: z.boolean(),
  tiers: z.object({ L1: tierSettingSchema.optional(), L2: tierSettingSchema.optional(), L3: tierSettingSchema.optional() }).strict().default({}),
  /**
   * Stronger model and effort for a task after its top tier did not solve it.
   * Setting it turns on escalation: a task first moves up one tier at a time,
   * and uses this setting only after its last tier also did not solve it.
   */
  escalation: tierSettingSchema.optional(),
}).strict();
export type DifficultyRoutingConfig = z.infer<typeof difficultyRoutingConfigSchema>;

/** What rated an automatic tier: the company decision model, the agent's own subscription CLI, or fixed rules. */
export const DIFFICULTY_CLASSIFIERS = ["decision_model", "agent_cli", "rules"] as const;
export type DifficultyClassifier = (typeof DIFFICULTY_CLASSIFIERS)[number];

/** Why an automatic tier was replaced by the agent's escalation setting. */
export const DIFFICULTY_ESCALATION_REASONS = ["run_failed", "changes_requested", "reopened"] as const;
export type DifficultyEscalationReason = (typeof DIFFICULTY_ESCALATION_REASONS)[number];

/**
 * "tier": the task moved up one tier (for example L2 to L3).
 * "escalation": the task moved from its last tier to the escalation setting. This is the final step.
 */
export const DIFFICULTY_ESCALATION_STEPS = ["tier", "escalation"] as const;
export type DifficultyEscalationStep = (typeof DIFFICULTY_ESCALATION_STEPS)[number];

export const issueDifficultyEscalationSchema = z.object({
  reason: z.enum(DIFFICULTY_ESCALATION_REASONS),
  step: z.enum(DIFFICULTY_ESCALATION_STEPS),
  fromTier: difficultyTierSchema,
  /** Review decision that caused this step, so one decision causes at most one step. */
  triggerDecisionId: z.string().nullable(),
  fromModel: z.string().nullable(),
  fromEffort: z.string().nullable(),
  triggerRunId: z.string().uuid().nullable(),
  escalatedAt: z.string(),
}).strict();
export type IssueDifficultyEscalation = z.infer<typeof issueDifficultyEscalationSchema>;

export const issueDifficultyRoutingSchema = z.object({
  tier: difficultyTierSchema,
  source: z.enum(["auto", "manual"]),
  classifier: z.enum(DIFFICULTY_CLASSIFIERS).optional(),
  agentId: z.string().uuid().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  decidedAt: z.string(),
  decisionInvocationId: z.string().uuid().nullable(),
  /** Set when the task moved to the escalation setting. model and effort then hold the escalation values. */
  escalation: issueDifficultyEscalationSchema.optional(),
}).strict();
export type IssueDifficultyRouting = z.infer<typeof issueDifficultyRoutingSchema>;

export const setIssueDifficultyTierSchema = z.object({ tier: difficultyTierSchema }).strict();

export const DIFFICULTY_ROUTED_CONFIG_KEYS = ["model", "effort", "modelReasoningEffort", "reasoningEffort", "variant"] as const;

export function difficultyEffortConfigKey(adapterType: string): string | null {
  switch (adapterType) {
    case "claude_local":
      return "effort";
    case "codex_local":
    case "paperclip_runner":
      return "modelReasoningEffort";
    case "grok_local":
      return "reasoningEffort";
    case "opencode_local":
      return "variant";
    default:
      return null;
  }
}

const RUNNER_TASK_CONFIG_PROVIDERS = ["codex", "opencode", "cursor_cloud"];
const RUNNER_TASK_CONFIG_ACPX_AGENTS = ["claude", "grok", "copilot"];

export function difficultyRoutingSupported(adapterType: string, adapterConfig: Record<string, unknown> | null | undefined): boolean {
  if (adapterType !== "paperclip_runner") return difficultyEffortConfigKey(adapterType) !== null;
  const provider = adapterConfig?.provider ?? "codex";
  if (provider === "acpx") return RUNNER_TASK_CONFIG_ACPX_AGENTS.includes(String(adapterConfig?.acpxAgent ?? "claude"));
  return RUNNER_TASK_CONFIG_PROVIDERS.includes(String(provider));
}

export function difficultyTierAdapterConfig(adapterType: string, setting: DifficultyTierSetting | undefined): Record<string, string> {
  const config: Record<string, string> = {};
  if (!setting) return config;
  if (setting.model) config.model = setting.model;
  const effortKey = difficultyEffortConfigKey(adapterType);
  if (setting.effort && effortKey) config[effortKey] = setting.effort;
  return config;
}

export function hasManualModelOrEffortOverride(adapterConfig: Record<string, unknown> | null | undefined): boolean {
  if (!adapterConfig) return false;
  return DIFFICULTY_ROUTED_CONFIG_KEYS.some((key) => {
    const value = adapterConfig[key];
    return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
  });
}

/** True when the escalation setting would change the model or effort of the given tier. */
export function difficultyEscalationAvailable(config: DifficultyRoutingConfig, tier: DifficultyTier): boolean {
  const escalation = config.escalation;
  if (!escalation?.model && !escalation?.effort) return false;
  const current = config.tiers[tier];
  return (escalation.model ?? current?.model) !== current?.model || (escalation.effort ?? current?.effort) !== current?.effort;
}

/**
 * The next step up from a tier that did not solve a task, or null when there is
 * none. Escalation is on only when the agent has an escalation setting. A task
 * first moves up through the configured tiers that change the model or effort.
 * It reaches the escalation setting only from the last of them, so an expensive
 * escalation model is used only after the strongest tier did not solve the task.
 */
export function nextDifficultyEscalationStep(
  config: DifficultyRoutingConfig, tier: DifficultyTier,
): { step: "tier"; tier: DifficultyTier } | { step: "escalation" } | null {
  if (!config.escalation?.model && !config.escalation?.effort) return null;
  const current = config.tiers[tier];
  for (const next of DIFFICULTY_TIERS.slice(DIFFICULTY_TIERS.indexOf(tier) + 1)) {
    const setting = config.tiers[next];
    if (setting && (setting.model !== current?.model || setting.effort !== current?.effort)) return { step: "tier", tier: next };
  }
  return difficultyEscalationAvailable(config, tier) ? { step: "escalation" } : null;
}

/** The tier setting with the escalation values applied on top. */
export function difficultyEscalationSetting(config: DifficultyRoutingConfig, tier: DifficultyTier): DifficultyTierSetting {
  return { ...(config.tiers[tier] ?? {}), ...(config.escalation ?? {}) };
}

export function readDifficultyRoutingConfig(runtimeConfig: Record<string, unknown> | null | undefined): DifficultyRoutingConfig | null {
  const parsed = difficultyRoutingConfigSchema.safeParse(runtimeConfig?.difficultyRouting);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}
