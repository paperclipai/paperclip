import type { AccountRow, CcrotateTarget } from "./types.js";

interface RateLimits {
  utilization5h?: number | null;
  utilization7d?: number | null;
  remaining5h?: number | null;
  remaining7d?: number | null;
  resetAt?: number | string | null;
  reset5h?: number | string | null;
  reset7d?: number | string | null;
  planType?: string | null;
  snapshotCapturedAt?: string | null;
  [key: string]: unknown;
}

interface ExhaustionRecord {
  reset5h?: number | string | null;
  reset7d?: number | string | null;
  response?: string | null;
}

export interface TierCacheAccount {
  email: string;
  status?: string | null;
  serviceTier?: string | null;
  response?: string | null;
  exhausted?: Record<string, ExhaustionRecord | null | undefined> | null;
  exhaustedModel?: string | null;
  rateLimits?: RateLimits | null;
  [key: string]: unknown;
}

export interface TierCacheSnapshot {
  updatedAt?: string | null;
  accounts?: TierCacheAccount[];
}

interface Profile {
  stale?: boolean;
  staleReason?: string | null;
  oauthAccount?: {
    seatTier?: string | null;
  } | null;
  credentials?: {
    claudeAiOauth?: {
      accessToken?: string | null;
      expiresAt?: number | string | null;
      rateLimitTier?: string | null;
    } | null;
  } | null;
  auth?: unknown;
  tokenClaims?: {
    exp?: number | null;
  } | null;
}

export type ProfilesSnapshot = Record<string, Profile | undefined>;

interface RateLimitBucket {
  limit?: number | null;
  remaining?: number | null;
}

interface AnthropicRateLimitEntry {
  cooldownUntil?: string | null;
  last429Reason?: string | null;
  requests?: RateLimitBucket | null;
  inputTokens?: RateLimitBucket | null;
  outputTokens?: RateLimitBucket | null;
}

export interface RateLimitState {
  anthropic?: {
    accounts?: Record<string, {
      modelGroups?: Record<string, AnthropicRateLimitEntry | null | undefined>;
    } | null | undefined>;
  } | null;
}

function resetToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
}

function compactBucket(bucket: RateLimitBucket | null | undefined, unit = ""): string | null {
  if (!bucket) return null;
  const { limit, remaining } = bucket;
  if (limit == null && remaining == null) return null;
  if (remaining != null && limit != null) return `${remaining}${unit}/${limit}${unit}`;
  if (remaining != null) return `${remaining}${unit} left`;
  return `${limit}${unit} limit`;
}

function summarizeAnthropicRateLimit(entry: AnthropicRateLimitEntry | null | undefined, now: Date): string {
  if (!entry) return "api unknown";
  const cooldownMs = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
  if (Number.isFinite(cooldownMs) && cooldownMs > now.getTime()) {
    const seconds = Math.max(1, Math.ceil((cooldownMs - now.getTime()) / 1000));
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    const text = mins > 0 ? `${mins}m${rem ? `${rem}s` : ""}` : `${seconds}s`;
    return `cooldown ${text}${entry.last429Reason ? ` · 429 ${entry.last429Reason}` : ""}`;
  }
  const req = compactBucket(entry.requests);
  if (req) return `req ${req}`;
  const input = compactBucket(entry.inputTokens, "t");
  const output = compactBucket(entry.outputTokens, "t");
  if (input || output) return [input ? `in ${input}` : null, output ? `out ${output}` : null].filter(Boolean).join(" ");
  return "api ok";
}

function shortModelGroup(group: string): string {
  const match = group.match(/claude-(haiku|sonnet|opus|other)/i);
  return match ? match[1]!.toLowerCase() : group;
}

function isActiveCooldown(entry: AnthropicRateLimitEntry | null | undefined, nowMs: number): boolean {
  const cooldownMs = entry?.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
  return Number.isFinite(cooldownMs) && cooldownMs > nowMs;
}

function summarizeRelevantApiLimits(
  modelGroups: Record<string, AnthropicRateLimitEntry | null | undefined>,
  now: Date,
): { text: string; limited: boolean; resetAt: number | null } {
  const entries = Object.entries(modelGroups || {}).filter(([, entry]) => !!entry) as [string, AnthropicRateLimitEntry][];
  if (entries.length === 0) return { text: "api unknown", limited: false, resetAt: null };

  const nowMs = now.getTime();
  const rank = (group: string) => {
    if (group === "claude-opus") return 0;
    if (group === "claude-sonnet") return 1;
    if (group === "claude-haiku") return 2;
    if (group === "claude-other") return 3;
    return 4;
  };
  const cooldowns = entries
    .filter(([, entry]) => isActiveCooldown(entry, nowMs))
    .sort(([left], [right]) => rank(left) - rank(right));
  const chosen = cooldowns[0] ?? entries.sort(([left], [right]) => rank(left) - rank(right))[0]!;
  const [group, entry] = chosen;
  const cooldownMs = cooldowns.length > 0 ? Date.parse(cooldowns[0]![1].cooldownUntil ?? "") : NaN;
  return {
    text: `${shortModelGroup(group)} ${summarizeAnthropicRateLimit(entry, now)}`,
    limited: cooldowns.length > 0,
    resetAt: Number.isFinite(cooldownMs) ? cooldownMs : null,
  };
}

function readExhaustion(entry: TierCacheAccount | null | undefined): Record<string, ExhaustionRecord> {
  if (!entry || typeof entry !== "object") return {};
  const out: Record<string, ExhaustionRecord> = {};
  if (entry.exhausted && typeof entry.exhausted === "object") {
    for (const [key, value] of Object.entries(entry.exhausted)) {
      if (value && typeof value === "object") out[key] = value;
    }
  }
  if (Object.keys(out).length === 0 && entry.serviceTier === "exhausted") {
    const model = entry.exhaustedModel ?? (entry.rateLimits?.exhaustedModel as string | undefined) ?? "*";
    out[model] = {
      reset5h: entry.rateLimits?.reset5h ?? null,
      reset7d: entry.rateLimits?.reset7d ?? null,
      response: entry.response ?? null,
    };
  }
  if (
    Object.keys(out).length === 0 &&
    typeof entry.response === "string" &&
    /^quota exhausted/.test(entry.response) &&
    (entry.rateLimits?.reset5h != null || entry.rateLimits?.reset7d != null)
  ) {
    out["*"] = {
      reset5h: entry.rateLimits?.reset5h ?? null,
      reset7d: entry.rateLimits?.reset7d ?? null,
      response: entry.response,
    };
  }
  if (Object.keys(out).length === 0 && (entry.rateLimits?.utilization7d ?? 0) >= 100) {
    out["*"] = {
      reset5h: entry.rateLimits?.reset5h ?? null,
      reset7d: entry.rateLimits?.reset7d ?? null,
      response: entry.response ?? "utilization7d=100",
    };
  }
  return out;
}

function exhaustionRecordActive(record: ExhaustionRecord | null | undefined, nowMs: number): boolean {
  if (!record) return false;
  const reset = Math.max(Number(record.reset5h) || 0, Number(record.reset7d) || 0);
  return reset > 0 && reset * 1000 > nowMs;
}

function isAccountExhausted(entry: TierCacheAccount | null | undefined, nowMs: number): boolean {
  return Object.values(readExhaustion(entry)).some((record) => exhaustionRecordActive(record, nowMs));
}

function exhaustedModels(entry: TierCacheAccount | null | undefined): string[] {
  return Object.keys(readExhaustion(entry)).filter((model) => model !== "*");
}

function minKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length > 0 ? Math.min(...known) : null;
}

function tierSuffix(profile: Profile | undefined): string {
  const seatTier = profile?.oauthAccount?.seatTier || "";
  const rateLimitTier = profile?.credentials?.claudeAiOauth?.rateLimitTier || "";
  if (seatTier === "team_tier_1") return "·prem";
  if (seatTier === "team_standard") return "·std";
  if (seatTier === "unassigned") return "·off";
  const teamMatch = seatTier.match(/^team_tier_(\d+)$/);
  if (teamMatch) return `·t${teamMatch[1]}`;
  const rateMatch = rateLimitTier.match(/_(\d+)x$/);
  return rateMatch ? `·${rateMatch[1]}x` : "";
}

function futureAvailableAt(row: AccountRow & { nextReset?: number | null; apiLimitReset?: number | null }): number | null {
  const blockers = [row.nextReset, row.apiLimitReset].filter((value): value is number => value != null && value > Date.now());
  return blockers.length > 0 ? Math.max(...blockers) : null;
}

function whenSortKey(row: AccountRow & {
  nextReset?: number | null;
  apiLimitReset?: number | null;
  apiLimited?: boolean;
  availabilityScore?: number | null;
  atCap?: boolean;
  hasUsagePercent?: boolean;
  staleReason?: string | null;
}, originalIndex: number): [number, number, number, number] {
  if (row.isStale) return [row.staleReason === "organization_disabled" ? 6 : 5, 0, 0, originalIndex];
  if (!row.apiLimited && row.availability === "usable now") return [0, 0, -(row.availabilityScore ?? 0), originalIndex];
  const availableAt = futureAvailableAt(row);
  if (availableAt != null) return [1, availableAt, 0, originalIndex];
  if (row.apiLimited) return [2, 0, 0, originalIndex];
  if (row.hasUsagePercent && row.atCap) return [3, 0, 0, originalIndex];
  return [4, 0, 0, originalIndex];
}

type InternalRow = AccountRow & {
  apiLimited?: boolean;
  apiLimitReset?: number | null;
  atCap?: boolean;
  availabilityScore?: number | null;
  hasUsagePercent?: boolean;
  nextReset?: number | null;
  staleReason?: string | null;
};

function finalizeRows(rows: InternalRow[], activeEmail: string | null): AccountRow[] {
  return rows
    .map((row) => ({
      ...row,
      isActive:
        row.email === activeEmail &&
        !row.isStale &&
        !row.tier.toLowerCase().includes("exhausted") &&
        !row.apiLimited,
    }))
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = whenSortKey(left.row, left.index);
      const b = whenSortKey(right.row, right.index);
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    })
    .map(({ row }) => ({
      email: row.email,
      target: row.target,
      tier: row.tier,
      utilization5h: row.utilization5h,
      utilization7d: row.utilization7d,
      utilization7dSonnet: row.utilization7dSonnet,
      utilization7dOpus: row.utilization7dOpus,
      availability: row.availability,
      availabilityMark: row.availabilityMark,
      apiLimit: row.apiLimit,
      isActive: row.isActive,
      isHealthy: row.isHealthy,
      isStale: row.isStale,
    }));
}

function claudeRow(
  email: string,
  profile: Profile | undefined,
  cached: TierCacheAccount | undefined,
  rateLimitState: RateLimitState | null,
  nowMs: number,
): InternalRow {
  const rateLimits = cached?.rateLimits ?? {};
  const utilization5h = typeof rateLimits.utilization5h === "number" ? rateLimits.utilization5h : null;
  const utilization7d = typeof rateLimits.utilization7d === "number" ? rateLimits.utilization7d : null;
  const resetAt = resetToMs(rateLimits.resetAt);
  const reset5h = resetToMs(rateLimits.reset5h);
  const reset7d = resetToMs(rateLimits.reset7d);
  const exhausted = isAccountExhausted(cached, nowMs);
  const healthTier = cached?.serviceTier && cached.serviceTier !== "exhausted" ? cached.serviceTier : null;
  const tierBase = exhausted ? "exhausted" : (healthTier || "?");
  const isStale = !!profile?.stale;
  const hasUsagePercent = utilization5h != null || utilization7d != null;
  const hasResetEpoch = reset5h != null || reset7d != null || resetAt != null;
  const hasPerAccountData = hasUsagePercent || exhausted || hasResetEpoch;
  const isUsableNow =
    hasUsagePercent &&
    tierBase !== "exhausted" &&
    (utilization5h ?? 100) < 95 &&
    (utilization7d ?? 100) < 95 &&
    !isStale;

  const fiveHBlocked = utilization5h != null && utilization5h >= 95 && !!reset5h && reset5h > nowMs;
  const sevenDResetMs = reset7d || resetAt;
  const sevenDBlocked = utilization7d != null && utilization7d >= 95 && !!sevenDResetMs && sevenDResetMs > nowMs;
  let nextReset: number | null = null;
  if (fiveHBlocked && sevenDBlocked) nextReset = Math.max(reset5h!, sevenDResetMs!);
  else if (fiveHBlocked) nextReset = reset5h;
  else if (sevenDBlocked) nextReset = sevenDResetMs;
  else nextReset = [reset5h, reset7d, resetAt].filter((reset): reset is number => !!reset && reset > nowMs).sort((a, b) => a - b)[0] ?? null;

  const modelGroups = rateLimitState?.anthropic?.accounts?.[email]?.modelGroups ?? {};
  const apiLimit = summarizeRelevantApiLimits(modelGroups, new Date(nowMs));
  const models = exhaustedModels(cached).map((model) => model.match(/(haiku|sonnet|opus)/i)?.[1]?.toLowerCase() ?? model);
  const atCap = (utilization5h != null && utilization5h >= 95) || (utilization7d != null && utilization7d >= 95);
  const noDataMessage = cached?.response || "no data (needs refresh)";

  let availabilityMark: string | null = null;
  let availability = "";
  if (isStale) {
    if (profile?.staleReason === "organization_disabled") {
      availabilityMark = "🚫";
      availability = "org-disabled (admin must enable)";
    } else {
      availabilityMark = "🔴";
      availability = "stale (needs /login + snap)";
    }
  } else if (apiLimit.limited) {
    availabilityMark = "🤌";
    availability = apiLimit.text;
  } else if (isUsableNow) {
    availabilityMark = "🟢";
    availability = "usable now";
  } else if (!hasPerAccountData) {
    availabilityMark = /Usage API on cooldown|429/i.test(noDataMessage) ? "🔵" : "❔";
    availability = noDataMessage;
  } else if (tierBase === "exhausted") {
    const scope = models.length > 0 ? ` (${models.join(", ")})` : "";
    availabilityMark = "⏳";
    availability = nextReset ? `in ${fmtDuration(nextReset - nowMs)}${scope}` : `exhausted${scope}`;
  } else if (nextReset) {
    availabilityMark = "🟡";
    availability = `in ${fmtDuration(nextReset - nowMs)}`;
  } else if (hasUsagePercent && atCap) {
    availabilityMark = "🟡";
    availability = "capped (reset unknown)";
  } else {
    availabilityMark = "🔵";
    availability = "needs refresh";
  }

  return {
    email,
    target: "claude",
    tier: `${tierBase}${tierSuffix(profile)}`,
    utilization5h: utilization5h != null ? Math.round(utilization5h) : null,
    utilization7d: utilization7d != null ? Math.round(utilization7d) : null,
    utilization7dSonnet: null,
    utilization7dOpus: null,
    availability,
    availabilityMark,
    apiLimit: apiLimit.text,
    isActive: false,
    isHealthy: !!profile?.credentials?.claudeAiOauth?.accessToken,
    isStale,
    apiLimited: apiLimit.limited,
    apiLimitReset: apiLimit.resetAt,
    atCap,
    availabilityScore: minKnown([
      utilization5h != null ? 100 - utilization5h : null,
      utilization7d != null ? 100 - utilization7d : null,
    ]),
    hasUsagePercent,
    nextReset,
    staleReason: profile?.staleReason ?? null,
  };
}

function codexRow(email: string, profile: Profile | undefined, cached: TierCacheAccount | undefined, nowMs: number): InternalRow {
  const rateLimits = cached?.rateLimits ?? {};
  const remaining5h = typeof rateLimits.remaining5h === "number" ? rateLimits.remaining5h : null;
  const remaining7d = typeof rateLimits.remaining7d === "number" ? rateLimits.remaining7d : null;
  const resetAt = resetToMs(rateLimits.resetAt);
  const reset5h = resetToMs(rateLimits.reset5h);
  const reset7d = resetToMs(rateLimits.reset7d);
  const exhausted = isAccountExhausted(cached, nowMs);
  const tier = exhausted ? "exhausted" : (cached?.serviceTier || "?");
  const isStale = !!profile?.stale;
  const hasUsagePercent = remaining5h != null || remaining7d != null;
  const hasResetEpoch = reset5h != null || reset7d != null || resetAt != null;
  const hasPerAccountData = hasUsagePercent || exhausted || hasResetEpoch;
  const isUsableNow =
    hasUsagePercent &&
    (tier === "available" || tier === "near_limit") &&
    !exhausted &&
    (remaining5h == null || remaining5h > 0) &&
    (remaining7d == null || remaining7d > 0) &&
    !isStale;
  const fiveHBlocked = remaining5h != null && remaining5h <= 0 && !!reset5h && reset5h > nowMs;
  const sevenDBlocked = remaining7d != null && remaining7d <= 0 && !!reset7d && reset7d > nowMs;
  let nextReset: number | null = null;
  if (fiveHBlocked && sevenDBlocked) nextReset = Math.max(reset5h!, reset7d!);
  else if (fiveHBlocked) nextReset = reset5h;
  else if (sevenDBlocked) nextReset = reset7d;
  else nextReset = [reset5h, reset7d, resetAt].filter((reset): reset is number => !!reset && reset > nowMs).sort((a, b) => a - b)[0] ?? null;

  const models = exhaustedModels(cached).map((model) => model.match(/(gpt-[^, ]+|o\d)/i)?.[1]?.toLowerCase() ?? model);
  const atCap = (remaining5h != null && remaining5h <= 0) || (remaining7d != null && remaining7d <= 0);
  const noDataMessage = cached?.response || (cached?.status ? "no per-account data" : "no data (needs refresh)");

  let availabilityMark: string | null = null;
  let availability = "";
  if (isStale) {
    availabilityMark = "🔴";
    availability = "stale (needs /login + snap)";
  } else if (isUsableNow) {
    availabilityMark = tier === "near_limit" ? "🟡" : "🟢";
    availability = "usable now";
  } else if (!hasPerAccountData) {
    availabilityMark = /429|cooldown/i.test(noDataMessage) ? "🔵" : "❔";
    availability = noDataMessage;
  } else if (tier === "exhausted") {
    const scope = models.length > 0 ? ` (${models.join(", ")})` : "";
    availabilityMark = "⏳";
    availability = nextReset ? `in ${fmtDuration(nextReset - nowMs)}${scope}` : `exhausted${scope}`;
  } else if (nextReset) {
    availabilityMark = "🟡";
    availability = `in ${fmtDuration(nextReset - nowMs)}`;
  } else if (hasUsagePercent && atCap) {
    availabilityMark = "🟡";
    availability = "capped (reset unknown)";
  } else {
    availabilityMark = "🔵";
    availability = "needs refresh";
  }

  return {
    email,
    target: "codex",
    tier,
    utilization5h: remaining5h != null ? Math.round(remaining5h) : null,
    utilization7d: remaining7d != null ? Math.round(remaining7d) : null,
    utilization7dSonnet: null,
    utilization7dOpus: null,
    availability,
    availabilityMark,
    apiLimit: rateLimits.planType ?? "n/a",
    isActive: false,
    isHealthy: !!profile?.auth,
    isStale,
    apiLimited: false,
    apiLimitReset: null,
    atCap,
    availabilityScore: minKnown([remaining5h, remaining7d]),
    hasUsagePercent,
    nextReset,
    staleReason: profile?.staleReason ?? null,
  };
}

export function buildAccountRows(input: {
  target: CcrotateTarget;
  profiles: ProfilesSnapshot;
  tierCache: TierCacheSnapshot | null;
  rateLimitState?: RateLimitState | null;
  activeEmail?: string | null;
  now?: number;
}): AccountRow[] {
  const now = input.now ?? Date.now();
  const cachedByEmail = new Map(
    (Array.isArray(input.tierCache?.accounts) ? input.tierCache!.accounts! : [])
      .filter((account): account is TierCacheAccount => !!account && typeof account.email === "string" && account.email.length > 0)
      .map((account) => [account.email, account]),
  );
  const rows = Object.keys(input.profiles || {}).map((email) => (
    input.target === "codex"
      ? codexRow(email, input.profiles[email], cachedByEmail.get(email), now)
      : claudeRow(email, input.profiles[email], cachedByEmail.get(email), input.rateLimitState ?? null, now)
  ));
  return finalizeRows(rows, input.activeEmail ?? null);
}

export function tierCacheAge(updatedAt: string | null | undefined, now = Date.now()): string | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  const minutes = Math.max(0, Math.round((now - parsed) / 60_000));
  return `${minutes}m`;
}
