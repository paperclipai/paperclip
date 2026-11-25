import { z } from "zod";
import { AI_PROVIDERS, type AiAuthMethod, type AiProvider } from "./ai-connections.js";

const CLOUD_TRIAL_AUTH_METHODS = ["subscription", "api_key"] as const;

export const CLOUD_TRIAL_EXHAUSTED_ERROR_CODE = "cloud_trial_exhausted" as const;
export const CLOUD_TRIAL_DEFAULT_MODEL = "openrouter/openai/gpt-6-luna" as const;
export const CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS = 100 as const;

/**
 * Canonical starter-trial model normalizer used across onboarding seed, UI,
 * and server proxy/key-store so every layer agrees on the `openrouter/` prefix.
 */
export function resolveCloudTrialModel(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return CLOUD_TRIAL_DEFAULT_MODEL;
  return trimmed.startsWith("openrouter/") ? trimmed : `openrouter/${trimmed}`;
}

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
  /** Whether the requesting user has permission to migrate all trial agents in this company. */
  canMigrate: boolean;
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
  acpxAgent?: string;
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
  acpxAgent?: string;
  model: string;
}

export type CloudTrialMigrationTargetOverrides = Partial<
  Record<AiProvider, Partial<CloudTrialMigrationTarget>>
>;

const cloudTrialMigrationTargetOverrideSchema = z
  .object({
    adapterType: z.string().trim().min(1).max(100).optional(),
    runnerProvider: z.string().trim().min(1).max(100).optional(),
    acpxAgent: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * Parses deployment-owned migration target overrides from a JSON string
 * (e.g. `PAPERCLIP_CLOUD_TRIAL_MIGRATION_TARGETS`). Fails closed to `{}` on
 * invalid input so a malformed env value never crashes startup.
 */
export function parseCloudTrialMigrationTargetsEnv(
  raw?: string | null,
): CloudTrialMigrationTargetOverrides {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: CloudTrialMigrationTargetOverrides = {};
    for (const provider of AI_PROVIDERS) {
      const candidate = (parsed as Record<string, unknown>)[provider];
      if (!candidate) continue;
      const validated = cloudTrialMigrationTargetOverrideSchema.safeParse(candidate);
      if (validated.success) {
        result[provider] = validated.data;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Maps a newly connected user AI provider to the runner harness + model used
 * when migrating agents off starter inference. Deployment repositories may
 * supply `configuredTargets` (via `PAPERCLIP_CLOUD_TRIAL_MIGRATION_TARGETS`)
 * to override adapter/provider/model defaults without a Core release.
 */
export function defaultMigrationTargetForProvider(
  provider: AiProvider,
  _method: AiAuthMethod,
  overrideModel?: string,
  configuredTargets?: CloudTrialMigrationTargetOverrides,
): CloudTrialMigrationTarget {
  const customModel = overrideModel?.trim() || undefined;
  const configured = configuredTargets?.[provider];
  let base: CloudTrialMigrationTarget;
  switch (provider) {
    case "openai":
      base = {
        adapterType: "paperclip_runner",
        runnerProvider: "codex",
        model: "gpt-6-luna",
      };
      break;
    case "anthropic":
      base = {
        adapterType: "paperclip_runner",
        runnerProvider: "claude",
        model: "claude-sonnet-4-6",
      };
      break;
    case "google":
      base = {
        adapterType: "paperclip_runner",
        runnerProvider: "acpx",
        acpxAgent: "antigravity",
        model: "gemini-2.5-pro",
      };
      break;
    case "xai":
      base = {
        adapterType: "grok_local",
        model: "grok-4",
      };
      break;
    case "openrouter":
      base = {
        adapterType: "paperclip_runner",
        runnerProvider: "opencode",
        model: CLOUD_TRIAL_DEFAULT_MODEL,
      };
      break;
    case "github":
      base = {
        adapterType: "paperclip_runner",
        runnerProvider: "acpx",
        acpxAgent: "copilot",
        model: "gpt-5.6-luna",
      };
      break;
  }

  const merged: CloudTrialMigrationTarget = {
    adapterType: configured?.adapterType ?? base.adapterType,
    ...(configured?.runnerProvider !== undefined
      ? { runnerProvider: configured.runnerProvider }
      : base.runnerProvider !== undefined
        ? { runnerProvider: base.runnerProvider }
        : {}),
    ...(configured?.acpxAgent !== undefined
      ? { acpxAgent: configured.acpxAgent }
      : base.acpxAgent !== undefined
        ? { acpxAgent: base.acpxAgent }
        : {}),
    model: customModel ?? configured?.model ?? base.model,
  };
  return merged;
}

export function isAgentUsingCloudTrialInference(runtimeConfig: unknown): boolean {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    return false;
  }
  return (runtimeConfig as Record<string, unknown>).cloudTrialInference === true;
}
