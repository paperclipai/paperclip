import { z } from "zod";
import { AI_PROVIDERS, type AiAuthMethod, type AiProvider } from "./ai-connections.js";

const CLOUD_TRIAL_AUTH_METHODS = ["subscription", "api_key"] as const;

export const CLOUD_TRIAL_EXHAUSTED_ERROR_CODE = "cloud_trial_exhausted" as const;
export const CLOUD_TRIAL_DEFAULT_MODEL = "openrouter/openai/gpt-6-luna" as const;
export const CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS = 100 as const;

export const CLOUD_TRIAL_INFERENCE_STATUSES = [
  "unavailable",
  "not_issued",
  "active",
  "exhausted",
  "disabled",
  "ineligible",
  "migrated",
] as const;
export type CloudTrialInferenceState = (typeof CLOUD_TRIAL_INFERENCE_STATUSES)[number];

export interface CloudTrialBlockedRunSummary {
  runId: string;
  agentId: string;
  issueId: string | null;
  failedAt: string;
}

export interface CloudTrialInferenceStatus {
  enabled: boolean;
  provider: "openrouter";
  status: CloudTrialInferenceState;
  reason?: string;
  limitUsdCents: number;
  spentUsdCents: number;
  remainingUsdCents: number;
  defaultModel: string;
  /** Non-terminated agents in this company currently configured to use Cloud starter inference. */
  trialAgentIds: string[];
  /** Human-readable summaries of trial-bound agents for modal copy. */
  trialAgents: Array<{
    id: string;
    name: string;
    role: string;
    title: string | null;
  }>;
  /** Most recent run blocked by trial exhaustion, if any. */
  blockedRun: CloudTrialBlockedRunSummary | null;
}

export const migrateCloudTrialAgentsSchema = z
  .object({
    connectionId: z.string().uuid(),
    grantId: z.string().uuid(),
    provider: z.enum(AI_PROVIDERS),
    method: z.enum(CLOUD_TRIAL_AUTH_METHODS),
    ownership: z.enum(["personal", "shared"]).default("personal"),
    model: z.string().trim().min(1).max(200).optional(),
    agentIds: z.array(z.string().uuid()).max(200).optional(),
    resumeBlockedWork: z.boolean().default(true),
  })
  .strict();

export type MigrateCloudTrialAgentsInput = z.infer<typeof migrateCloudTrialAgentsSchema>;

export const cloudTrialTelemetryEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("onboarding_exposure"),
    surface: z.enum(["onboarding_wizard", "onboarding_seed"]).default("onboarding_wizard"),
  }).strict(),
  z.object({
    event: z.literal("modal_shown"),
    trialAgentCount: z.number().int().nonnegative().max(1000),
  }).strict(),
]);

export type CloudTrialTelemetryEventInput = z.infer<typeof cloudTrialTelemetryEventSchema>;

export interface MigratedCloudTrialAgentSummary {
  agentId: string;
  name: string;
  adapterType: string;
  runnerProvider?: string;
  model: string;
}

export interface MigrateCloudTrialAgentsResult {
  migratedCount: number;
  agents: MigratedCloudTrialAgentSummary[];
  resumedRunIds: string[];
  resumedIssueId: string | null;
}

export interface CloudTrialMigrationTarget {
  adapterType: string;
  runnerProvider?: string;
  model: string;
}

/**
 * Maps a newly connected user AI provider to the default harness + model used
 * when migrating agents off the Cloud OpenRouter starter trial.
 */
export function defaultMigrationTargetForProvider(
  provider: AiProvider,
  _method: AiAuthMethod,
  overrideModel?: string,
): CloudTrialMigrationTarget {
  const customModel = overrideModel?.trim() || undefined;
  switch (provider) {
    case "openai":
      return {
        adapterType: "paperclip_runner",
        runnerProvider: "codex",
        model: customModel ?? "gpt-6-luna",
      };
    case "anthropic":
      return {
        adapterType: "paperclip_runner",
        runnerProvider: "claude",
        model: customModel ?? "claude-sonnet-4-6",
      };
    case "google":
      return {
        adapterType: "paperclip_runner",
        runnerProvider: "antigravity",
        model: customModel ?? "gemini-2.5-pro",
      };
    case "xai":
      return {
        adapterType: "grok_local",
        model: customModel ?? "grok-4",
      };
    case "openrouter":
      return {
        adapterType: "paperclip_runner",
        runnerProvider: "opencode",
        model: customModel ?? CLOUD_TRIAL_DEFAULT_MODEL,
      };
    case "github":
      return {
        adapterType: "paperclip_runner",
        runnerProvider: "copilot",
        model: customModel ?? "gpt-5.6-luna",
      };
  }
}

export function isAgentUsingCloudTrialInference(runtimeConfig: unknown): boolean {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    return false;
  }
  return (runtimeConfig as Record<string, unknown>).cloudTrialInference === true;
}
