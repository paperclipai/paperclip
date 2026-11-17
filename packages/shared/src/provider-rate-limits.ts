/**
 * Latest provider rate-limit windows an agent's harness reported (Codex
 * `account/rateLimits/updated`, Claude `rate_limit_event`). The runner carries a
 * snapshot as one JSON detail on a `provider.notice.recorded` event with
 * category {@link PROVIDER_RATE_LIMITS_NOTICE_CATEGORY}; the server keeps the
 * merged latest snapshot in `agent_runtime_state.state_json` under
 * {@link PROVIDER_RATE_LIMITS_STATE_KEY}.
 */
export const PROVIDER_RATE_LIMITS_NOTICE_CATEGORY = "provider.rate_limits";
export const PROVIDER_RATE_LIMITS_SCHEMA = "paperclip.provider.rate_limits.v1";
export const PROVIDER_RATE_LIMITS_NOTICE_DETAIL = "rateLimits";
export const PROVIDER_RATE_LIMITS_STATE_KEY = "providerRateLimits";
export const PROVIDER_RATE_LIMIT_WARN_PERCENT = 80;

export type ProviderRateLimitProvider = "openai" | "anthropic";

export interface ProviderRateLimitWindow {
  id: string;
  /** "5-hour window", "Weekly", "Weekly (Opus)" */
  label: string;
  /** "5h", "7d" */
  shortLabel: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
  status: "allowed" | "warning" | "rejected" | null;
}

export interface ProviderRateLimitSnapshot {
  schema: typeof PROVIDER_RATE_LIMITS_SCHEMA;
  provider: ProviderRateLimitProvider;
  windows: ProviderRateLimitWindow[];
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  limitReached: { windowId: string | null; reason: string; resetsAt: string | null } | null;
  observedAt: string;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
const str = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const iso = (value: unknown): string | null => {
  const text = str(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** Validate an untrusted snapshot (from a run event or stored state). */
export function parseProviderRateLimitSnapshot(value: unknown): ProviderRateLimitSnapshot | null {
  const raw = obj(value);
  if (!raw || raw.schema !== PROVIDER_RATE_LIMITS_SCHEMA) return null;
  if (raw.provider !== "openai" && raw.provider !== "anthropic") return null;
  const observedAt = iso(raw.observedAt);
  if (!observedAt || !Array.isArray(raw.windows)) return null;
  const windows: ProviderRateLimitWindow[] = [];
  for (const entry of raw.windows.slice(0, 8)) {
    const window = obj(entry);
    const id = str(window?.id);
    const label = str(window?.label);
    if (!window || !id || !label) continue;
    const status = window.status === "allowed" || window.status === "warning" || window.status === "rejected" ? window.status : null;
    const usedPercent = num(window.usedPercent);
    const windowMinutes = num(window.windowMinutes);
    windows.push({
      id,
      label,
      shortLabel: str(window.shortLabel, 40) ?? label,
      windowMinutes: windowMinutes !== null && windowMinutes > 0 ? windowMinutes : null,
      usedPercent: usedPercent === null ? null : Math.min(1000, Math.max(0, usedPercent)),
      resetsAt: iso(window.resetsAt),
      status,
    });
  }
  const credits = obj(raw.credits);
  const reached = obj(raw.limitReached);
  return {
    schema: PROVIDER_RATE_LIMITS_SCHEMA,
    provider: raw.provider,
    windows,
    credits: credits
      ? { hasCredits: bool(credits.hasCredits), unlimited: bool(credits.unlimited), balance: str(credits.balance, 40) }
      : null,
    limitReached: reached
      ? { windowId: str(reached.windowId), reason: str(reached.reason) ?? "rate_limit_reached", resetsAt: iso(reached.resetsAt) }
      : null,
    observedAt,
  };
}

/** The snapshot carried by a rate-limit `provider.notice.recorded` payload, if any. */
export function providerRateLimitSnapshotFromNotice(
  eventType: string,
  payload: Record<string, unknown>,
): ProviderRateLimitSnapshot | null {
  if (eventType !== "provider.notice.recorded") return null;
  if (payload.schema !== "paperclip.provider.notice.v1" || payload.category !== PROVIDER_RATE_LIMITS_NOTICE_CATEGORY) return null;
  const details = Array.isArray(payload.details) ? payload.details : [];
  const detail = details.map(obj).find((entry) => entry?.name === PROVIDER_RATE_LIMITS_NOTICE_DETAIL);
  if (typeof detail?.value !== "string") return null;
  try {
    return parseProviderRateLimitSnapshot(JSON.parse(detail.value));
  } catch {
    return null;
  }
}

export function isProviderRateLimitNotice(eventType: string, payload: Record<string, unknown>): boolean {
  return eventType === "provider.notice.recorded"
    && payload.schema === "paperclip.provider.notice.v1"
    && payload.category === PROVIDER_RATE_LIMITS_NOTICE_CATEGORY;
}

/**
 * Merge a newer snapshot into the stored one. Runners already merge within a
 * session; this keeps windows another session reported and ignores
 * out-of-order deliveries.
 */
export function mergeProviderRateLimitSnapshots(
  stored: ProviderRateLimitSnapshot | null,
  next: ProviderRateLimitSnapshot,
): ProviderRateLimitSnapshot {
  if (!stored || stored.provider !== next.provider) return next;
  const at = Date.parse(next.observedAt);
  if (at < Date.parse(stored.observedAt)) return stored;
  // Claude reports one window per event and Codex updates are sparse: a null
  // field never clears a known value.
  const windows = new Map(stored.windows.map((window) => [window.id, window]));
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
  // A report about another window does not clear a still-current rejection.
  const reportedIds = new Set(next.windows.map((window) => window.id));
  const storedReached = stored.limitReached;
  const keepStoredReached = storedReached !== null
    && storedReached.windowId !== null
    && !reportedIds.has(storedReached.windowId)
    && (storedReached.resetsAt === null || Date.parse(storedReached.resetsAt) > at);
  return {
    ...next,
    windows: [...windows.values()].slice(0, 8),
    credits: next.credits ?? stored.credits,
    limitReached: next.limitReached ?? (keepStoredReached ? storedReached : null),
  };
}

export function readProviderRateLimits(stateJson: Record<string, unknown> | null | undefined): ProviderRateLimitSnapshot | null {
  return parseProviderRateLimitSnapshot(stateJson?.[PROVIDER_RATE_LIMITS_STATE_KEY]);
}

export interface ProviderRateLimitSummary {
  tone: "normal" | "warn" | "reached";
  /** The window the one-line summary describes. */
  window: ProviderRateLimitWindow | null;
  /** Set while the provider is refusing work and the reset is still ahead. */
  limitedUntil: string | null;
  limited: boolean;
  /**
   * The provider reports a window as used up but the account has credits, so
   * work continues on credits (Codex) instead of waiting for the reset.
   */
  usingCredits: boolean;
  /** Windows whose reset has not passed yet, fullest first. */
  current: ProviderRateLimitWindow[];
}

/**
 * Which window to show, given the clock. A window whose reset time has passed
 * has rolled over, so its stored percentage no longer applies.
 */
export function summarizeProviderRateLimits(
  snapshot: ProviderRateLimitSnapshot | null,
  now: number,
): ProviderRateLimitSummary | null {
  if (!snapshot) return null;
  const live = (resetsAt: string | null) => !resetsAt || Date.parse(resetsAt) > now;
  const current = snapshot.windows
    .filter((window) => window.usedPercent !== null && live(window.resetsAt))
    .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
  const reached = snapshot.limitReached;
  const hasCredits = snapshot.credits?.unlimited === true || snapshot.credits?.hasCredits === true;
  const reachedNow = reached !== null && live(reached.resetsAt)
    && (reached.resetsAt !== null || now - Date.parse(snapshot.observedAt) < 3_600_000);
  if (reached && reachedNow && !hasCredits) {
    const window = snapshot.windows.find((candidate) => candidate.id === reached.windowId) ?? current[0] ?? null;
    return { tone: "reached", window, limitedUntil: reached.resetsAt, limited: true, usingCredits: false, current };
  }
  const window = current[0] ?? null;
  if (!window) return null;
  const pct = window.usedPercent ?? 0;
  const usingCredits = hasCredits && (reachedNow || pct >= 100);
  return {
    tone: usingCredits ? "warn" : pct >= 100 ? "reached" : pct > PROVIDER_RATE_LIMIT_WARN_PERCENT ? "warn" : "normal",
    window,
    limitedUntil: null,
    limited: false,
    usingCredits,
    current,
  };
}
