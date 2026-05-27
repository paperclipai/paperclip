export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
  // ADR-0044 additions
  maxCachedInputTokens: number;        // T1: threshold on cache_read_input_tokens (0 = disabled)
  rotateOnZeroOpenIssues: boolean;     // T3: rotate when openIssuesCount == 0
  rotateOnNewIssueWake: boolean;       // T4: rotate when wakeReason == "issue_assigned"
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

const DEFAULT_SESSION_COMPACTION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 200,
  maxRawInputTokens: 2_000_000,
  maxSessionAgeHours: 72,
  maxCachedInputTokens: 0,
  rotateOnZeroOpenIssues: false,
  rotateOnNewIssueWake: false,
};

// Adapters with native context management still participate in session resume,
// but Paperclip should not rotate them using threshold-based compaction.
const ADAPTER_MANAGED_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
  maxCachedInputTokens: 0,
  rotateOnZeroOpenIssues: false,
  rotateOnNewIssueWake: false,
};

// ADR-0044 «Heartbeat session lifecycle» — fresh-session policy applied to claude_local by default.
// Per-agent overrides (e.g. CEO/CoS/Analyst T1=1M / T2=12h) are configured via runtimeConfig.heartbeat.sessionCompaction.
const CLAUDE_LOCAL_ADR_0044_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,                    // not used (variant D rejected by ADR-0044)
  maxRawInputTokens: 0,                 // not used (cached_input is the meaningful signal)
  maxSessionAgeHours: 6,                // T2 default for execution agents
  maxCachedInputTokens: 500_000,        // T1 default for execution agents
  rotateOnZeroOpenIssues: true,         // T3
  rotateOnNewIssueWake: true,           // T4
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
    defaultSessionCompaction: CLAUDE_LOCAL_ADR_0044_POLICY,
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
  const maxCachedInputTokens = readNumber(compaction.maxCachedInputTokens);
  const rotateOnZeroOpenIssues = readBoolean(compaction.rotateOnZeroOpenIssues);
  const rotateOnNewIssueWake = readBoolean(compaction.rotateOnNewIssueWake);

  if (enabled !== undefined) explicit.enabled = enabled;
  if (maxSessionRuns !== undefined) explicit.maxSessionRuns = maxSessionRuns;
  if (maxRawInputTokens !== undefined) explicit.maxRawInputTokens = maxRawInputTokens;
  if (maxSessionAgeHours !== undefined) explicit.maxSessionAgeHours = maxSessionAgeHours;
  if (maxCachedInputTokens !== undefined) explicit.maxCachedInputTokens = maxCachedInputTokens;
  if (rotateOnZeroOpenIssues !== undefined) explicit.rotateOnZeroOpenIssues = rotateOnZeroOpenIssues;
  if (rotateOnNewIssueWake !== undefined) explicit.rotateOnNewIssueWake = rotateOnNewIssueWake;

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
      maxCachedInputTokens: explicitOverride.maxCachedInputTokens ?? basePolicy.maxCachedInputTokens,
      rotateOnZeroOpenIssues: explicitOverride.rotateOnZeroOpenIssues ?? basePolicy.rotateOnZeroOpenIssues,
      rotateOnNewIssueWake: explicitOverride.rotateOnNewIssueWake ?? basePolicy.rotateOnNewIssueWake,
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
  | "maxSessionRuns"
  | "maxRawInputTokens"
  | "maxSessionAgeHours"
  | "maxCachedInputTokens"
  | "rotateOnZeroOpenIssues"
  | "rotateOnNewIssueWake"
>) {
  return (
    policy.maxSessionRuns > 0 ||
    policy.maxRawInputTokens > 0 ||
    policy.maxSessionAgeHours > 0 ||
    policy.maxCachedInputTokens > 0 ||
    policy.rotateOnZeroOpenIssues === true ||
    policy.rotateOnNewIssueWake === true
  );
}
