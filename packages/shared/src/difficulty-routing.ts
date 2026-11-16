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
}).strict();
export type DifficultyRoutingConfig = z.infer<typeof difficultyRoutingConfigSchema>;

/** What rated an automatic tier: the company decision model, the agent's own subscription CLI, or fixed rules. */
export const DIFFICULTY_CLASSIFIERS = ["decision_model", "agent_cli", "rules"] as const;
export type DifficultyClassifier = (typeof DIFFICULTY_CLASSIFIERS)[number];

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

export function readDifficultyRoutingConfig(runtimeConfig: Record<string, unknown> | null | undefined): DifficultyRoutingConfig | null {
  const parsed = difficultyRoutingConfigSchema.safeParse(runtimeConfig?.difficultyRouting);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}
