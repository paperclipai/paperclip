/**
 * Provider quota detection shared by every adapter execution path.
 *
 * Quota exhaustion is not a normal turn failure: the server has a dedicated
 * recovery path for it (wait for the reset instead of re-assigning the issue and
 * re-waking the agent). That path is keyed on `errorCode: "provider_quota"` /
 * `errorFamily: "provider_quota"`, so any execution path that reports a quota
 * refusal as a generic failure silently disarms it.
 *
 * The CLI adapters (`claude-local`, `codex-local`) each carry their own copy of
 * this matching. This module holds the message-level core so protocol-based
 * execution paths — which never see adapter stdout — can classify the same way.
 */

const PROVIDER_QUOTA_MESSAGE_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:session|usage)\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|usage\s+limit\s+(?:reached|exceeded)|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|quota\s+(?:limit\s+)?exceeded|servicequotaexceededexception)/i;

const PROVIDER_QUOTA_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:session|usage)\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+(?:reached|exceeded)|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!·]|\n|$)/i;

const CLOCK_TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;

/** Whether a provider refusal message reports exhausted quota. */
export function isProviderQuotaMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_QUOTA_MESSAGE_RE.test(text);
}

/**
 * Resolve the next occurrence of `hour:minute` in an IANA time zone. The reset
 * hint carries a zone name ("resets 8am (Europe/Moscow)"), so the wall clock has
 * to be interpreted there rather than in the host's local zone.
 */
function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const { now, hour, minute, timeZoneHint } = input;
  const timeZone = timeZoneHint.trim();
  if (!timeZone) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }

  // Offsets change across DST boundaries, so converge instead of assuming one.
  const zoneOffsetMs = (at: Date): number | null => {
    const parts = formatter.formatToParts(at);
    const read = (type: string) => {
      const value = parts.find((part) => part.type === type)?.value;
      return value ? Number.parseInt(value, 10) : Number.NaN;
    };
    const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
    if (Number.isNaN(asUtc)) return null;
    return asUtc - at.getTime();
  };

  const buildAt = (dayOffset: number): Date | null => {
    const offsetNow = zoneOffsetMs(now);
    if (offsetNow === null) return null;
    const zoneNow = new Date(now.getTime() + offsetNow);
    let candidate = new Date(
      Date.UTC(
        zoneNow.getUTCFullYear(),
        zoneNow.getUTCMonth(),
        zoneNow.getUTCDate() + dayOffset,
        hour,
        minute,
        0,
        0,
      ) - offsetNow,
    );
    for (let i = 0; i < 3; i += 1) {
      const offsetCandidate = zoneOffsetMs(candidate);
      if (offsetCandidate === null) return null;
      const adjustment = offsetNow - offsetCandidate;
      if (adjustment === 0) break;
      candidate = new Date(candidate.getTime() + adjustment);
    }
    return candidate;
  };

  const sameDay = buildAt(0);
  if (!sameDay) return null;
  if (sameDay.getTime() > now.getTime()) return sameDay;
  return buildAt(1);
}

function parseResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const match = clockText.trim().replace(/\s+/g, " ").match(CLOCK_TIME_RE);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({ now, hour: hour24, minute, timeZoneHint });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) retryAt.setDate(retryAt.getDate() + 1);
  return retryAt;
}

/** Reset instant advertised by a quota refusal, when it states one. */
export function parseProviderQuotaRetryNotBefore(
  text: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!text) return null;
  const match = text.match(PROVIDER_QUOTA_RESET_RE);
  if (!match) return null;
  return parseResetClockTime(match[1] ?? "", now, match[2]);
}

export interface ProviderQuotaClassification {
  errorCode: "provider_quota";
  errorFamily: "provider_quota";
  /** ISO instant when the quota resets, or `null` when the message omits it. */
  retryNotBefore: string | null;
}

/**
 * Classify a failure message as provider quota exhaustion. Returns `null` for
 * every other failure so callers keep their existing classification.
 */
export function classifyProviderQuotaFailure(
  text: string | null | undefined,
  now = new Date(),
): ProviderQuotaClassification | null {
  if (!isProviderQuotaMessage(text)) return null;
  const retryAt = parseProviderQuotaRetryNotBefore(text, now);
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: retryAt ? retryAt.toISOString() : null,
  };
}
