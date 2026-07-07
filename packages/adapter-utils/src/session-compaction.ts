/**
 * Context guard strategy — what to do when a compaction threshold fires.
 *
 * - `summarize`: produce a continuation summary, then restart the session fresh.
 *   The summary is stored as an issue document keyed by
 *   `"continuation-summary"` so the next run can pick it up.
 * - `truncate`: drop oldest turns from the session transcript, keeping the
 *   system prompt and most recent N exchanges.
 * - `rotate`: end the current session and start a new one with no carry-over.
 */
export type ContextGuardStrategy = "summarize" | "truncate" | "rotate";

export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
  /** Per-run token ceiling — fires mid-run if raw input exceeds this. */
  maxTokensPerRun: number;
  /** Strategy applied when a compaction threshold is reached. */
  guardStrategy: ContextGuardStrategy;
}

export type NativeContextManagement = "confirmed" | "likely" | "unknown" | "none";

export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: NativeContextManagement;
  defaultSessionCompaction: SessionCompactionPolicy;
}

export interface ResolvedSessionCompactionPolicy {
  policy: SessionCompactionPolicy;
  adapterSessionManagement: AdapterSessionManagement | null;
  explicitOverride: Partial<SessionCompactionPolicy>;
  source: "adapter_default" | "agent_override" | "legacy_fallback";
}

// ---------------------------------------------------------------------------
// Defaults — tuned for Kimi / DeepSeek / unknown models that crash from
// context exhaustion. For adapters with confirmed native context management
// (Claude, Hermes) thresholds are zero-valued (no host-side rotation).
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_COMPACTION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 80,
  maxRawInputTokens: 640_000,
  maxSessionAgeHours: 48,
  maxTokensPerRun: 180_000,
  guardStrategy: "summarize",
};

const ADAPTER_MANAGED_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
  maxTokensPerRun: 0,
  guardStrategy: "summarize",
};

export const LEGACY_SESSIONED_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

export const ADAPTER_SESSION_MANAGEMENT: Record<string, AdapterSessionManagement> = {
  acpx_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  claude_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  codex_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  cursor_cloud: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  cursor: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  gemini_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  opencode_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  pi_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  hermes_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
};

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function readGuardStrategy(value: unknown): ContextGuardStrategy | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "summarize" || v === "truncate" || v === "rotate") return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAdapterSessionManagement(adapterType: string | null | undefined): AdapterSessionManagement | null {
  if (!adapterType) return null;
  return ADAPTER_SESSION_MANAGEMENT[adapterType] ?? null;
}

export function readSessionCompactionOverride(runtimeConfig: unknown): Partial<SessionCompactionPolicy> {
  const runtime = isRecord(runtimeConfig) ? runtimeConfig : {};
  const heartbeat = isRecord(runtime.heartbeat) ? runtime.heartbeat : {};
  const compaction = isRecord(
    heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction,
  )
    ? (heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction) as Record<string, unknown>
    : {};

  const explicit: Partial<SessionCompactionPolicy> = {};
  const enabled = readBoolean(compaction.enabled);
  const maxSessionRuns = readNumber(compaction.maxSessionRuns);
  const maxRawInputTokens = readNumber(compaction.maxRawInputTokens);
  const maxSessionAgeHours = readNumber(compaction.maxSessionAgeHours);
  const maxTokensPerRun = readNumber(compaction.maxTokensPerRun);
  const guardStrategy = readGuardStrategy(compaction.guardStrategy);

  if (enabled !== undefined) explicit.enabled = enabled;
  if (maxSessionRuns !== undefined) explicit.maxSessionRuns = maxSessionRuns;
  if (maxRawInputTokens !== undefined) explicit.maxRawInputTokens = maxRawInputTokens;
  if (maxSessionAgeHours !== undefined) explicit.maxSessionAgeHours = maxSessionAgeHours;
  if (maxTokensPerRun !== undefined) explicit.maxTokensPerRun = maxTokensPerRun;
  if (guardStrategy !== undefined) explicit.guardStrategy = guardStrategy;

  return explicit;
}

export function resolveSessionCompactionPolicy(
  adapterType: string | null | undefined,
  runtimeConfig: unknown,
): ResolvedSessionCompactionPolicy {
  const adapterSessionManagement = getAdapterSessionManagement(adapterType);
  const explicitOverride = readSessionCompactionOverride(runtimeConfig);
  const hasExplicitOverride = Object.keys(explicitOverride).length > 0;
  const fallbackEnabled = Boolean(adapterType && LEGACY_SESSIONED_ADAPTER_TYPES.has(adapterType));
  const basePolicy = adapterSessionManagement?.defaultSessionCompaction ?? {
    ...DEFAULT_SESSION_COMPACTION_POLICY,
    enabled: fallbackEnabled,
  };

  return {
    policy: {
      enabled: explicitOverride.enabled ?? basePolicy.enabled,
      maxSessionRuns: explicitOverride.maxSessionRuns ?? basePolicy.maxSessionRuns,
      maxRawInputTokens: explicitOverride.maxRawInputTokens ?? basePolicy.maxRawInputTokens,
      maxSessionAgeHours: explicitOverride.maxSessionAgeHours ?? basePolicy.maxSessionAgeHours,
      maxTokensPerRun: explicitOverride.maxTokensPerRun ?? basePolicy.maxTokensPerRun,
      guardStrategy: explicitOverride.guardStrategy ?? basePolicy.guardStrategy,
    },
    adapterSessionManagement,
    explicitOverride,
    source: hasExplicitOverride
      ? "agent_override"
      : adapterSessionManagement
        ? "adapter_default"
        : "legacy_fallback",
  };
}

export function hasSessionCompactionThresholds(policy: Pick<
  SessionCompactionPolicy,
  "maxSessionRuns" | "maxRawInputTokens" | "maxSessionAgeHours" | "maxTokensPerRun"
>) {
  return policy.maxSessionRuns > 0 || policy.maxRawInputTokens > 0
    || policy.maxSessionAgeHours > 0 || policy.maxTokensPerRun > 0;
}

/**
 * Check whether a single run's raw input exceeds the per-run token ceiling.
 * Returns the strategy to apply if the ceiling is breached, or null if OK.
 */
export function checkRunTokenCeiling(
  policy: Pick<SessionCompactionPolicy, "maxTokensPerRun" | "guardStrategy">,
  rawInputTokens: number,
): ContextGuardStrategy | null {
  if (policy.maxTokensPerRun > 0 && rawInputTokens > policy.maxTokensPerRun) {
    return policy.guardStrategy;
  }
  return null;
}
