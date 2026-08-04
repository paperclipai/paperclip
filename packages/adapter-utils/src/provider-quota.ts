/**
 * Provider-quota detection shared by every execution path.
 *
 * Quota refusals ("you've hit your session limit", "usage limit reached", …)
 * carry a dedicated recovery contract on the server: `errorFamily:
 * "provider_quota"` arms the wait-recovery monitor and the bounded deferred
 * retry, and `retryNotBefore` tells them when the window reopens. That contract
 * only engages when the execution result is labelled, so every path that can
 * surface a provider refusal has to run the same detector.
 *
 * The CLI adapters classified quota locally, but the ACPX engine lives in this
 * package and could not reach the adapter-side regexes, so ACPX runs reported a
 * generic turn failure and fell through to immediate escalation. Keeping the
 * patterns here gives both the engine and the adapters one source of truth.
 */

const PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;

/**
 * Captures the reset clock time and its optional parenthesised time zone, e.g.
 * `… session limit · resets 8am (Europe/Moscow)` → `8am` + `Europe/Moscow`.
 */
const PROVIDER_QUOTA_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

export interface ProviderQuotaClassification {
  /** Reset instant parsed from the refusal, when the provider stated one. */
  retryNotBefore: Date | null;
}

/** True when `text` reads as a provider quota/usage refusal. */
export function isProviderQuotaMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_QUOTA_RE.test(text);
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Resolve a wall-clock instant in `timeZone`. `Date.UTC` gives the right
 * instant only for UTC, so converge on the offset instead of assuming one, then
 * verify — an unrepresentable local time (DST spring-forward gap) yields null.
 */
function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0),
  );
  const targetUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    0,
    0,
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  // The provider states a bare clock time; if it already passed today it names
  // tomorrow's window.
  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(
      Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0),
    );
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseResetClockTime(
  clockText: string,
  now: Date,
  timeZoneHint?: string | null,
): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  // No usable zone hint: fall back to the host clock rather than dropping the
  // reset time, which would leave the retry unbounded.
  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

/** Reset instant stated in a quota refusal, or null when it states none. */
export function extractProviderQuotaRetryNotBefore(
  text: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!text) return null;
  const match = text.match(PROVIDER_QUOTA_RESET_RE);
  if (!match) return null;
  return parseResetClockTime(match[1] ?? "", now, match[2]);
}

/**
 * Classify `text` as a provider quota refusal, or null when it is not one.
 * A match with no stated reset time still classifies — the family alone routes
 * recovery to wait-and-retry instead of immediate escalation.
 */
export function classifyProviderQuota(
  text: string | null | undefined,
  now = new Date(),
): ProviderQuotaClassification | null {
  if (!isProviderQuotaMessage(text)) return null;
  return { retryNotBefore: extractProviderQuotaRetryNotBefore(text, now) };
}
