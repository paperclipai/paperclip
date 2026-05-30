import { createHash } from "node:crypto";
import type {
  AdapterEnvironmentTestResult,
  AgentAdapterType,
  AgentExecutionPolicy,
  AgentExecutionProfile,
  IssueExecutionOverrides,
  ProviderQuotaResult,
  QuotaWindow,
} from "@paperclipai/shared";

const LOCAL_MODEL_ADAPTER_TYPES: AgentAdapterType[] = [
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
];

const DEFAULT_FALLBACK_ORDER: AgentAdapterType[] = [
  "codex_local",
  "claude_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "hermes_local",
];

const SHARED_EXECUTION_PROFILE_KEYS = [
  "cwd",
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "timeoutSec",
  "graceSec",
  "env",
  "workspaceStrategy",
  "workspaceRuntime",
] as const;

type SharedExecutionProfileKey = (typeof SHARED_EXECUTION_PROFILE_KEYS)[number];

type FallbackDecision =
  | {
    action: "run";
    adapterType: string;
    config: Record<string, unknown>;
    reason?: string;
    diagnostics: AvailabilityDiagnostic[];
  }
  | {
    action: "block";
    reason: string;
    diagnostics: AvailabilityDiagnostic[];
  };

type AvailabilityDiagnostic = {
  adapterType: string;
  available: boolean;
  reason: string;
};

type ProbeResult = {
  available: boolean;
  reason: string;
};

type CandidateAvailabilityContext = {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  getQuotaWindows: (adapterType: string) => Promise<ProviderQuotaResult | null>;
  testEnvironment: (
    adapterType: string,
    config: Record<string, unknown>,
  ) => Promise<AdapterEnvironmentTestResult | null>;
  now: Date;
};

const availabilityCache = new Map<string, { expiresAt: number; result: ProbeResult }>();
const AVAILABILITY_CACHE_TTL_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isModelCompatibleWithAdapter(adapterType: string, model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;

  switch (adapterType) {
    case "claude_local":
      return normalized.startsWith("claude");
    case "codex_local":
      return !normalized.includes("/") && (
        normalized.startsWith("gpt-") ||
        normalized.startsWith("o1") ||
        normalized.startsWith("o3") ||
        normalized.startsWith("o4") ||
        normalized.includes("codex")
      );
    case "hermes_local":
      return isHermesCompatibleModel(normalized);
    case "opencode_local":
      return /^[^/\s]+\/[^/\s]+$/.test(normalized);
    default:
      return true;
  }
}

function isHermesCompatibleModel(model: string | null): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (/^deepseek-v4-(?:flash|pro)(?:\[[^\]]+\])?$/.test(normalized)) return true;
  if (normalized === "deepseek-chat" || normalized === "deepseek-reasoner") return true;
  return /^[^/\s]+\/[^/\s]+$/.test(normalized);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeAdapterTypes(values: string[]): AgentAdapterType[] {
  const seen = new Set<AgentAdapterType>();
  const result: AgentAdapterType[] = [];
  for (const value of values) {
    if (!LOCAL_MODEL_ADAPTER_TYPES.includes(value as AgentAdapterType) && value !== "process" && value !== "http" && value !== "openclaw_gateway") {
      continue;
    }
    const typedValue = value as AgentAdapterType;
    if (seen.has(typedValue)) continue;
    seen.add(typedValue);
    result.push(typedValue);
  }
  return result;
}

function defaultExecutionPolicy(primaryAdapterType: string): AgentExecutionPolicy {
  if (!LOCAL_MODEL_ADAPTER_TYPES.includes(primaryAdapterType as AgentAdapterType)) {
    return {
      mode: "fixed",
      compatibleAdapterTypes: [primaryAdapterType as AgentAdapterType],
      preferredAdapterTypes: [primaryAdapterType as AgentAdapterType],
    };
  }

  if (primaryAdapterType === "hermes_local") {
    return {
      mode: "prefer_available",
      compatibleAdapterTypes: ["hermes_local", "codex_local"],
      preferredAdapterTypes: ["hermes_local", "codex_local"],
    };
  }

  return {
    mode: "prefer_available",
    compatibleAdapterTypes: dedupeAdapterTypes([
      primaryAdapterType,
      ...LOCAL_MODEL_ADAPTER_TYPES,
    ]),
    preferredAdapterTypes: dedupeAdapterTypes([
      primaryAdapterType,
      ...DEFAULT_FALLBACK_ORDER,
    ]),
  };
}

function parseExecutionPolicy(
  adapterType: string,
  runtimeConfig: Record<string, unknown>,
): AgentExecutionPolicy {
  const raw = asRecord(runtimeConfig.executionPolicy);
  const defaults = defaultExecutionPolicy(adapterType);
  const compatibleAdapterTypes = dedupeAdapterTypes(
    Array.isArray(raw.compatibleAdapterTypes)
      ? raw.compatibleAdapterTypes.filter((value): value is string => typeof value === "string")
      : defaults.compatibleAdapterTypes ?? [],
  );
  const preferredAdapterTypes = dedupeAdapterTypes(
    Array.isArray(raw.preferredAdapterTypes)
      ? raw.preferredAdapterTypes.filter((value): value is string => typeof value === "string")
      : defaults.preferredAdapterTypes ?? compatibleAdapterTypes,
  );
  const mode = raw.mode === "fixed" || raw.mode === "prefer_available"
    ? raw.mode
    : defaults.mode;
  const perAdapterConfig = isPlainObject(raw.perAdapterConfig)
    ? Object.fromEntries(
        Object.entries(raw.perAdapterConfig).filter(
          (entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]),
        ),
      )
    : {};

  return {
    mode,
    compatibleAdapterTypes: compatibleAdapterTypes.length > 0
      ? compatibleAdapterTypes
      : defaults.compatibleAdapterTypes,
    preferredAdapterTypes: preferredAdapterTypes.length > 0
      ? preferredAdapterTypes
      : defaults.preferredAdapterTypes,
    perAdapterConfig,
  };
}

export function extractExecutionProfile(
  adapterConfig: Record<string, unknown>,
  runtimeConfig: Record<string, unknown>,
): AgentExecutionProfile {
  const explicitProfile = asRecord(runtimeConfig.executionProfile);
  const fromAdapterConfig = Object.fromEntries(
    SHARED_EXECUTION_PROFILE_KEYS
      .filter((key) => key in adapterConfig)
      .map((key) => [key, adapterConfig[key]]),
  ) as AgentExecutionProfile;
  return {
    ...fromAdapterConfig,
    ...explicitProfile,
  };
}

export function synthesizeExecutionRuntimeConfig(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}): Record<string, unknown> {
  const { adapterType, adapterConfig, runtimeConfig } = input;
  return {
    ...runtimeConfig,
    executionProfile: extractExecutionProfile(adapterConfig, runtimeConfig),
    executionPolicy: parseExecutionPolicy(adapterType, runtimeConfig),
  };
}

export function mergeExecutionProfileIntoConfig(
  adapterConfig: Record<string, unknown>,
  runtimeConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extractExecutionProfile(adapterConfig, runtimeConfig),
    ...adapterConfig,
  };
}

function sanitizeExecutionConfigForAdapter(
  adapterType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };

  switch (adapterType) {
    case "claude_local":
      delete next.dangerouslyBypassApprovalsAndSandbox;
      delete next.modelReasoningEffort;
      delete next.search;
      delete next.variant;
      break;
    case "codex_local":
      delete next.dangerouslySkipPermissions;
      delete next.effort;
      delete next.variant;
      break;
    case "hermes_local":
      delete next.dangerouslySkipPermissions;
      delete next.dangerouslyBypassApprovalsAndSandbox;
      delete next.effort;
      delete next.search;
      delete next.variant;
      {
        const model = asString(next.model);
        if (!isHermesCompatibleModel(model)) {
          delete next.model;
        }
      }
      break;
    case "opencode_local": {
      delete next.dangerouslySkipPermissions;
      delete next.dangerouslyBypassApprovalsAndSandbox;
      delete next.effort;
      delete next.modelReasoningEffort;
      delete next.search;
      const model = asString(next.model);
      if (model && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
        delete next.model;
      }
      break;
    }
    default:
      break;
  }

  return next;
}

function parseResetDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function windowIsExhausted(window: QuotaWindow, now: Date): boolean {
  if (window.usedPercent == null || window.usedPercent < 100) return false;
  const resetAt = parseResetDate(window.resetsAt);
  return resetAt == null || resetAt.getTime() > now.getTime();
}

function describeBlockedWindow(window: QuotaWindow): string {
  const resetAt = parseResetDate(window.resetsAt);
  const resetText = resetAt ? resetAt.toISOString() : "unknown reset";
  return `${window.label} exhausted until ${resetText}`;
}

export function getQuotaBlockReason(
  quota: ProviderQuotaResult | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!quota?.ok || quota.windows.length === 0) return null;
  const blockedWindow = quota.windows.find((window) => windowIsExhausted(window, now));
  return blockedWindow ? describeBlockedWindow(blockedWindow) : null;
}

function mapReasoningEffort(adapterType: string, reasoningEffort: string): Record<string, unknown> {
  if (!reasoningEffort) return {};
  switch (adapterType) {
    case "codex_local":
      return { modelReasoningEffort: reasoningEffort };
    case "claude_local":
      return { effort: reasoningEffort };
    case "opencode_local":
      return { variant: reasoningEffort };
    default:
      return {};
  }
}

function applyIssueExecutionOverrides(
  adapterType: string,
  config: Record<string, unknown>,
  overrides: IssueExecutionOverrides | null,
): Record<string, unknown> {
  if (!overrides) return config;
  const next = { ...config };
  const overrideModel = asString(overrides.model);
  if (overrideModel && isModelCompatibleWithAdapter(adapterType, overrideModel)) {
    next.model = overrideModel;
  }
  if (typeof overrides.reasoningEffort === "string" && overrides.reasoningEffort.trim().length > 0) {
    Object.assign(next, mapReasoningEffort(adapterType, overrides.reasoningEffort.trim()));
  }
  if (overrides.chrome === true && adapterType === "claude_local") {
    next.chrome = true;
  }
  if (overrides.search === true && adapterType === "codex_local") {
    next.search = true;
  }
  const perAdapterConfig = isPlainObject(overrides.perAdapterConfig)
    ? asRecord(overrides.perAdapterConfig[adapterType])
    : {};
  return { ...next, ...perAdapterConfig };
}

export function buildExecutionConfigForAdapter(input: {
  agentAdapterType: string;
  executionAdapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  issueAdapterConfigOverride?: Record<string, unknown> | null;
  issueExecutionOverrides?: IssueExecutionOverrides | null;
}): Record<string, unknown> {
  const { agentAdapterType, executionAdapterType, adapterConfig, runtimeConfig } = input;
  const executionProfile = extractExecutionProfile(adapterConfig, runtimeConfig);
  const executionPolicy = parseExecutionPolicy(agentAdapterType, runtimeConfig);
  const candidatePolicyConfig = asRecord(
    asRecord(executionPolicy.perAdapterConfig)[executionAdapterType],
  );
  const basePrimarySpecificConfig =
    executionAdapterType === agentAdapterType ? adapterConfig : {};
  const legacyIssueAdapterOverride =
    executionAdapterType === agentAdapterType ? (input.issueAdapterConfigOverride ?? {}) : {};
  const merged = {
    ...executionProfile,
    ...basePrimarySpecificConfig,
    ...candidatePolicyConfig,
    ...legacyIssueAdapterOverride,
  };
  const withOverrides = applyIssueExecutionOverrides(
    executionAdapterType,
    merged,
    input.issueExecutionOverrides ?? null,
  );
  return sanitizeExecutionConfigForAdapter(executionAdapterType, withOverrides);
}

function buildAvailabilityCacheKey(input: {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}): string {
  const hash = createHash("sha1")
    .update(JSON.stringify(input.config))
    .digest("hex");
  return `${input.companyId}:${input.adapterType}:${hash}`;
}

function availabilityFromEnvironmentResult(
  result: AdapterEnvironmentTestResult | null,
): ProbeResult | null {
  if (!result) return null;
  if (result.status === "pass") {
    return { available: true, reason: "environment test passed" };
  }
  const checkReason = (check: AdapterEnvironmentTestResult["checks"][number]) => {
    const detail = asString(check.detail);
    return detail ? `${check.message}: ${detail}` : check.message;
  };
  const authCheck = result.checks.find((check) =>
    /auth_required|login_required|not_logged_in/i.test(check.code)
      || /login is required|not logged in/i.test(check.message),
  );
  if (authCheck) {
    return { available: false, reason: checkReason(authCheck) };
  }
  const hardFailure = result.checks.find((check) => check.level === "error");
  if (hardFailure) {
    return { available: false, reason: checkReason(hardFailure) };
  }
  return { available: true, reason: "environment test returned warnings only" };
}

async function probeAdapterAvailability(input: CandidateAvailabilityContext): Promise<ProbeResult> {
  const cacheKey = buildAvailabilityCacheKey({
    companyId: input.companyId,
    adapterType: input.adapterType,
    config: input.config,
  });
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const quota = await input.getQuotaWindows(input.adapterType);
  const blockedQuotaReason = getQuotaBlockReason(quota, input.now);
  if (blockedQuotaReason) {
    const result = { available: false, reason: blockedQuotaReason };
    availabilityCache.set(cacheKey, {
      expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS,
      result,
    });
    return result;
  }
  if (quota?.ok) {
    const result = { available: true, reason: `quota preflight ok (${quota.provider})` };
    availabilityCache.set(cacheKey, {
      expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  const envResult = availabilityFromEnvironmentResult(
    await input.testEnvironment(input.adapterType, input.config),
  );
  if (envResult) {
    availabilityCache.set(cacheKey, {
      expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS,
      result: envResult,
    });
    return envResult;
  }

  const fallbackResult =
    quota?.error
      ? { available: false, reason: quota.error }
      : { available: true, reason: "no explicit availability signals; proceeding" };
  availabilityCache.set(cacheKey, {
    expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS,
    result: fallbackResult,
  });
  return fallbackResult;
}

export async function resolveHeartbeatAdapterExecution(input: {
  companyId: string;
  primaryAdapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  issueAdapterConfigOverride?: Record<string, unknown> | null;
  issueExecutionOverrides?: IssueExecutionOverrides | null;
  getQuotaWindows: (adapterType: string) => Promise<ProviderQuotaResult | null>;
  testEnvironment: (
    adapterType: string,
    config: Record<string, unknown>,
  ) => Promise<AdapterEnvironmentTestResult | null>;
  now?: Date;
}): Promise<FallbackDecision> {
  const now = input.now ?? new Date();
  const executionRuntimeConfig = synthesizeExecutionRuntimeConfig({
    adapterType: input.primaryAdapterType,
    adapterConfig: input.adapterConfig,
    runtimeConfig: input.runtimeConfig,
  });
  const executionPolicy = parseExecutionPolicy(input.primaryAdapterType, executionRuntimeConfig);
  const preferredAdapters = executionPolicy.mode === "fixed"
    ? [input.primaryAdapterType]
    : dedupeAdapterTypes([
      input.primaryAdapterType,
      ...(executionPolicy.preferredAdapterTypes ?? []),
    ]);

  const diagnostics: AvailabilityDiagnostic[] = [];
  for (const candidateAdapterType of preferredAdapters) {
    const candidateConfig = buildExecutionConfigForAdapter({
      agentAdapterType: input.primaryAdapterType,
      executionAdapterType: candidateAdapterType,
      adapterConfig: input.adapterConfig,
      runtimeConfig: executionRuntimeConfig,
      issueAdapterConfigOverride: input.issueAdapterConfigOverride,
      issueExecutionOverrides: input.issueExecutionOverrides,
    });
    const availability = await probeAdapterAvailability({
      companyId: input.companyId,
      adapterType: candidateAdapterType,
      config: candidateConfig,
      getQuotaWindows: input.getQuotaWindows,
      testEnvironment: input.testEnvironment,
      now,
    });
    diagnostics.push({
      adapterType: candidateAdapterType,
      available: availability.available,
      reason: availability.reason,
    });
    if (availability.available) {
      const switched = candidateAdapterType !== input.primaryAdapterType;
      const primaryDiagnostic = diagnostics.find((entry) => entry.adapterType === input.primaryAdapterType);
      const primaryFailureReason =
        primaryDiagnostic && !primaryDiagnostic.available ? primaryDiagnostic.reason : null;
      return {
        action: "run",
        adapterType: candidateAdapterType,
        config: candidateConfig,
        reason: switched
          ? primaryFailureReason
            ? `Selected ${candidateAdapterType} because ${input.primaryAdapterType} was unavailable (${primaryFailureReason}).`
            : `Selected ${candidateAdapterType} because ${input.primaryAdapterType} was unavailable.`
          : availability.reason,
        diagnostics,
      };
    }
  }

  const diagnosticSummary = diagnostics
    .map((entry) => `${entry.adapterType}: ${entry.reason}`)
    .join("; ");

  return {
    action: "block",
    reason: diagnosticSummary || `No compatible execution adapters are available for ${input.primaryAdapterType}.`,
    diagnostics,
  };
}
