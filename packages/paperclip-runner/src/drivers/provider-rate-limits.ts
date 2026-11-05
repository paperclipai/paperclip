import type { CanonicalProviderEvent } from "../provider-events.js";

/**
 * Provider rate-limit windows reported by a harness, normalized into one
 * account-scoped snapshot and carried on a `provider.notice.recorded` event
 * (category {@link PROVIDER_RATE_LIMITS_CATEGORY}). The server keeps the latest
 * snapshot per agent; the transcript treats it as run-log only.
 *
 * Sources:
 * - Codex app-server `account/rateLimits/updated` (sparse RateLimitSnapshot:
 *   primary/secondary windows, credits, rateLimitReachedType).
 * - Claude `usage_update._meta["_claude/rateLimit"]` (SDK rate_limit_event:
 *   one window per event, utilization 0..1, status).
 */
export const PROVIDER_RATE_LIMITS_CATEGORY = "provider.rate_limits";
export const PROVIDER_RATE_LIMITS_SCHEMA = "paperclip.provider.rate_limits.v1";
export const PROVIDER_RATE_LIMITS_DETAIL = "rateLimits";

export interface ProviderRateLimitWindow {
  id: string;
  label: string;
  shortLabel: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
  status: "allowed" | "warning" | "rejected" | null;
}

export interface ProviderRateLimitSnapshot {
  schema: typeof PROVIDER_RATE_LIMITS_SCHEMA;
  provider: "openai" | "anthropic";
  windows: ProviderRateLimitWindow[];
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  limitReached: { windowId: string | null; reason: string; resetsAt: string | null } | null;
  observedAt: string;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function epochSecondsIso(value: unknown): string | null {
  const seconds = num(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function percent(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(Math.min(1000, Math.max(0, value)) * 10) / 10;
}

export function windowLabels(minutes: number | null): { label: string; shortLabel: string } {
  if (minutes === null) return { label: "Usage window", shortLabel: "Usage" };
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? { label: "Weekly", shortLabel: "7d" } : { label: `${weeks}-week window`, shortLabel: `${weeks * 7}d` };
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return { label: days === 1 ? "Daily" : `${days}-day window`, shortLabel: `${days}d` };
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return { label: `${hours}-hour window`, shortLabel: `${hours}h` };
  }
  return { label: `${minutes}-minute window`, shortLabel: `${minutes}m` };
}

/** Merge a sparse update: windows by id, null fields never clear a known value. */
export function mergeRateLimitSnapshot(
  previous: ProviderRateLimitSnapshot | null,
  next: ProviderRateLimitSnapshot,
): ProviderRateLimitSnapshot {
  if (!previous || previous.provider !== next.provider) return next;
  const windows = new Map(previous.windows.map((window) => [window.id, window]));
  for (const window of next.windows) {
    const prior = windows.get(window.id);
    windows.set(window.id, prior ? {
      ...window,
      usedPercent: window.usedPercent ?? prior.usedPercent,
      resetsAt: window.resetsAt ?? prior.resetsAt,
      windowMinutes: window.windowMinutes ?? prior.windowMinutes,
      status: window.status ?? prior.status,
    } : window);
  }
  return {
    ...next,
    windows: [...windows.values()].slice(0, 8),
    credits: next.credits ?? previous.credits,
  };
}

function codexWindow(limitId: string | null, limitName: string | null, slot: "primary" | "secondary", raw: unknown): ProviderRateLimitWindow | null {
  const window = obj(raw);
  if (!window) return null;
  const minutes = num(window.windowDurationMins);
  const labels = windowLabels(minutes !== null && minutes > 0 ? Math.round(minutes) : null);
  const scoped = limitId && limitId !== "codex";
  const scope = scoped ? (limitName ?? limitId) : null;
  return {
    id: `${scoped ? limitId : "codex"}.${slot}`,
    label: scope ? `${labels.label} (${scope})` : labels.label,
    shortLabel: scope ? `${labels.shortLabel} ${scope}` : labels.shortLabel,
    windowMinutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null,
    usedPercent: percent(num(window.usedPercent)),
    resetsAt: epochSecondsIso(window.resetsAt),
    status: null,
  };
}

/** Normalize Codex `account/rateLimits/updated` params, merged into the previous snapshot. */
export function codexRateLimitSnapshot(
  params: Obj,
  previous: ProviderRateLimitSnapshot | null,
  observedAt: string,
): ProviderRateLimitSnapshot | null {
  const snapshot = obj(params.rateLimits);
  if (!snapshot) return null;
  const limitId = str(snapshot.limitId);
  const limitName = str(snapshot.limitName);
  const windows = (["primary", "secondary"] as const)
    .map((slot) => codexWindow(limitId, limitName, slot, snapshot[slot]))
    .filter((window): window is ProviderRateLimitWindow => window !== null);
  const creditsRaw = obj(snapshot.credits);
  const credits = creditsRaw
    ? { hasCredits: bool(creditsRaw.hasCredits), unlimited: bool(creditsRaw.unlimited), balance: str(creditsRaw.balance, 40) }
    : null;
  const reason = str(snapshot.rateLimitReachedType);
  const merged = mergeRateLimitSnapshot(previous, {
    schema: PROVIDER_RATE_LIMITS_SCHEMA,
    provider: "openai",
    windows,
    credits,
    limitReached: null,
    observedAt,
  });
  if (merged.windows.length === 0 && !merged.credits && !reason) return null;
  // The reached type names no window; attribute it to the fullest one.
  const fullest = [...merged.windows].sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))[0] ?? null;
  const exhausted = merged.windows.find((window) => (window.usedPercent ?? 0) >= 100) ?? null;
  const reachedWindow = reason ? fullest : exhausted;
  merged.limitReached = reason || exhausted
    ? { windowId: reachedWindow?.id ?? null, reason: reason ?? "rate_limit_reached", resetsAt: reachedWindow?.resetsAt ?? null }
    : null;
  return merged;
}

const CLAUDE_WINDOWS: Record<string, { label: string; shortLabel: string; minutes: number | null }> = {
  five_hour: { label: "5-hour window", shortLabel: "5h", minutes: 300 },
  seven_day: { label: "Weekly", shortLabel: "7d", minutes: 10080 },
  seven_day_opus: { label: "Weekly (Opus)", shortLabel: "7d Opus", minutes: 10080 },
  seven_day_sonnet: { label: "Weekly (Sonnet)", shortLabel: "7d Sonnet", minutes: 10080 },
  seven_day_overage_included: { label: "Weekly (with extra usage)", shortLabel: "7d", minutes: 10080 },
  overage: { label: "Extra usage", shortLabel: "Extra", minutes: null },
};

/** Normalize Claude's `_claude/rateLimit` (SDK rate_limit_info), merged into the previous snapshot. */
export function claudeRateLimitSnapshot(
  meta: unknown,
  previous: ProviderRateLimitSnapshot | null,
  observedAt: string,
): ProviderRateLimitSnapshot | null {
  const info = obj(obj(meta)?.["_claude/rateLimit"]);
  if (!info) return null;
  const type = str(info.rateLimitType) ?? "five_hour";
  const known = CLAUDE_WINDOWS[type] ?? { label: type.replaceAll("_", " "), shortLabel: type, minutes: null };
  const rawStatus = str(info.status);
  const status = rawStatus === "allowed" ? "allowed" : rawStatus === "allowed_warning" ? "warning" : rawStatus === "rejected" ? "rejected" : null;
  const utilization = num(info.utilization);
  const window: ProviderRateLimitWindow = {
    id: `claude.${type}`,
    label: known.label,
    shortLabel: known.shortLabel,
    windowMinutes: known.minutes,
    usedPercent: status === "rejected" && utilization === null ? 100 : percent(utilization === null ? null : utilization * 100),
    resetsAt: epochSecondsIso(info.resetsAt),
    status,
  };
  const merged = mergeRateLimitSnapshot(previous, {
    schema: PROVIDER_RATE_LIMITS_SCHEMA,
    provider: "anthropic",
    windows: [window],
    credits: null,
    limitReached: null,
    observedAt,
  });
  const rejected = merged.windows.find((candidate) => candidate.status === "rejected") ?? null;
  merged.limitReached = rejected
    ? { windowId: rejected.id, reason: "rate_limit_reached", resetsAt: rejected.resetsAt }
    : null;
  return merged;
}

function fingerprint(snapshot: ProviderRateLimitSnapshot): string {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

export function rateLimitSnapshotChanged(
  previous: ProviderRateLimitSnapshot | null,
  next: ProviderRateLimitSnapshot,
): boolean {
  return !previous || fingerprint(previous) !== fingerprint(next);
}

function summary(snapshot: ProviderRateLimitSnapshot): string {
  const harness = snapshot.provider === "openai" ? "Codex" : "Claude";
  if (snapshot.limitReached) {
    const window = snapshot.windows.find((candidate) => candidate.id === snapshot.limitReached?.windowId);
    return `${harness} rate limit reached${window ? ` (${window.label})` : ""}${snapshot.limitReached.resetsAt ? `; resets ${snapshot.limitReached.resetsAt}` : ""}`;
  }
  const parts = snapshot.windows
    .filter((window) => window.usedPercent !== null)
    .map((window) => `${window.label} ${window.usedPercent}%`);
  return parts.length ? `${harness} rate limits: ${parts.join(", ")}` : `${harness} rate limits updated`;
}

export function rateLimitNoticeEvent(snapshot: ProviderRateLimitSnapshot, itemId: string): CanonicalProviderEvent {
  // Notice detail values are capped at 4000 characters; keep the JSON whole.
  const bounded = { ...snapshot, windows: [...snapshot.windows] };
  let serialized = JSON.stringify(bounded);
  while (serialized.length > 4000 && bounded.windows.length > 0) {
    bounded.windows.pop();
    serialized = JSON.stringify(bounded);
  }
  return {
    eventType: "provider.notice.recorded",
    itemId,
    payload: {
      schema: "paperclip.provider.notice.v1",
      noticeId: itemId,
      severity: snapshot.limitReached ? "warning" : "info",
      category: PROVIDER_RATE_LIMITS_CATEGORY,
      scope: "account",
      recoverable: true,
      userActionable: false,
      summary: summary(snapshot).slice(0, 4000),
      details: [{ name: PROVIDER_RATE_LIMITS_DETAIL, value: serialized }],
    },
  };
}
