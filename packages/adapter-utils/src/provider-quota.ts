/**
 * Provider-quota detection shared by every adapter surface.
 *
 * Subscription providers report an exhausted plan as a plain sentence with the
 * reset moment inline ("You've hit your weekly limit · resets Aug 1 at 10am
 * (Europe/Moscow)"). Recovery only backs off until that moment when the failing
 * run is tagged `errorFamily: "provider_quota"` with a `retryNotBefore`, so both
 * the CLI adapters and the ACP engine classify against the helpers below rather
 * than each carrying their own copy of the phrasing.
 */

const PROVIDER_QUOTA_PHRASE_SOURCE =
  "(?:you(?:'|’)ve\\s+hit\\s+your\\s+(?:usage|session|weekly|monthly|daily|5[-\\s]?hour)\\s+limit" +
  "|(?:usage|session|weekly|monthly|daily|5[-\\s]?hour)\\s+limit\\s+(?:reached|exceeded)" +
  "|out\\s+of\\s+extra\\s+usage|extra\\s+usage\\b" +
  "|claude\\s+usage\\s+limit\\s+reached" +
  "|usage\\s+limit\\b|usage\\s+cap\\s+reached" +
  "|provider\\s+quota|quota\\s+(?:limit\\s+)?exceeded" +
  "|model\\s+(?:is\\s+)?at\\s+capacity" +
  "|servicequotaexceededexception)";

/** Matches the sentence a provider emits when the plan's quota is exhausted. */
export const PROVIDER_QUOTA_TEXT_RE = new RegExp(PROVIDER_QUOTA_PHRASE_SOURCE, "i");

/**
 * Reset moment attached to a quota sentence. Both spellings occur in the wild:
 * `resets Aug 1 at 10am (Europe/Moscow)` and `try again at 4:30 PM (America/Chicago)`.
 * The date part is optional — a bare clock time means "the next time it is that hour".
 */
// Capture a generous window after the marker and pick the spec apart in code:
// one clever regex cannot both stop at sentence punctuation and keep the comma
// inside "Aug 1, 2026".
const RESET_MARKER_SOURCE = "(?:\\bresets?\\b(?:\\s+at)?|\\btry\\s+again\\s+at\\b)\\s+([^\\n]{1,80})";

/** Preferred: the reset that belongs to a quota sentence, not some unrelated "resets" nearby. */
const PROVIDER_QUOTA_RESET_RE = new RegExp(
  `${PROVIDER_QUOTA_PHRASE_SOURCE}[\\s\\S]{0,160}?${RESET_MARKER_SOURCE}`,
  "i",
);
/** Fallback for payloads where the quota sentence and the reset were assembled apart. */
const BARE_RESET_RE = new RegExp(RESET_MARKER_SOURCE, "i");

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const RESET_SPEC_RE = new RegExp(
  `^\\s*(?:(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s*(?:at\\s+)?)?` +
    "(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?\\s*m\\.?)?",
  "i",
);

/**
 * Zone stated right after the clock. The bare-letters form must not swallow a
 * trailing "PM"/"AM", or the reset lands twelve hours early.
 */
const RESET_ZONE_RE = /^\s*\(([^)\n]+)\)|^\s+(?![AP]\.?M\.?\b)([A-Z]{2,5})\b/i;

/** A dated reset this far in the past is a year-boundary wrap ("resets Jan 2" seen on Dec 31). */
const RESET_YEAR_WRAP_TOLERANCE_MS = 180 * 24 * 60 * 60 * 1000;

export function matchesProviderQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_QUOTA_TEXT_RE.test(text);
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
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

export function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
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
 * Resolve a wall-clock reading in `timeZone` to an absolute instant. Returns null
 * when the reading does not exist there (the hour skipped by a DST jump forward).
 */
export function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
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

export function nextClockTimeInTimeZone(input: {
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

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
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

type ResetSpec = {
  month: number | null;
  day: number | null;
  year: number | null;
  hour: number;
  minute: number;
};

function parseResetSpec(window: string): { spec: ResetSpec; rest: string } | null {
  const match = window.match(RESET_SPEC_RE);
  if (!match) return null;

  const monthName = match[1]?.toLowerCase();
  const month = monthName ? MONTHS.indexOf(monthName.slice(0, 3)) + 1 : null;
  const day = match[2] ? Number.parseInt(match[2], 10) : null;
  const year = match[3] ? Number.parseInt(match[3], 10) : null;
  const hourValue = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  const meridiem = (match[6] ?? "").toLowerCase();

  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) return null;
  if (!Number.isInteger(hourValue)) return null;
  // Without an am/pm marker the reading is already 24-hour.
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;

  return {
    spec: { month, day, year, hour, minute },
    rest: window.slice(match[0].length),
  };
}

function resolveDatedReset(spec: ResetSpec, now: Date, timeZone: string): Date | null {
  const month = spec.month;
  const day = spec.day;
  if (month === null || day === null) return null;

  const nowParts = readTimeZoneParts(now, timeZone);
  const build = (year: number) => dateFromTimeZoneWallClock({
    year,
    month,
    day,
    hour: spec.hour,
    minute: spec.minute,
    timeZone,
  });

  if (spec.year !== null) return build(spec.year);

  const sameYear = build(nowParts.year);
  if (sameYear && now.getTime() - sameYear.getTime() > RESET_YEAR_WRAP_TOLERANCE_MS) {
    return build(nowParts.year + 1) ?? sameYear;
  }
  return sameYear;
}

/**
 * Pull the reset instant out of a quota message. Returns null when the message
 * carries no readable reset — callers then fall back to their own backoff.
 */
export type ProviderQuotaResetOptions = {
  /**
   * Which zone a reset clock without a stated zone is read in. The CLI adapters
   * read it as the host's own zone (the CLI and the user share a machine); the
   * server reads it as UTC, since its runs are not tied to any one desk.
   */
  zonelessBasis?: "local" | "utc";
};

export function extractProviderQuotaResetAt(
  text: string | null | undefined,
  now = new Date(),
  options: ProviderQuotaResetOptions = {},
): Date | null {
  if (!text) return null;
  const anchored = text.match(PROVIDER_QUOTA_RESET_RE);
  const parsed = parseResetSpec(anchored?.[1] ?? "") ??
    parseResetSpec(text.match(BARE_RESET_RE)?.[1] ?? "");
  if (!parsed) return null;

  const { spec, rest } = parsed;
  const zoneMatch = rest.match(RESET_ZONE_RE);
  const timeZone = normalizeResetTimeZone(zoneMatch?.[1] ?? zoneMatch?.[2] ?? null);
  if (timeZone) {
    const dated = resolveDatedReset(spec, now, timeZone);
    if (dated) return dated;
    if (spec.month !== null) return null;
    const nextClock = nextClockTimeInTimeZone({
      now,
      hour: spec.hour,
      minute: spec.minute,
      timeZoneHint: timeZone,
    });
    if (nextClock) return nextClock;
  }

  // No usable zone: fall back to the caller's basis, which is still a far better
  // estimate than no backoff at all.
  const utcBasis = options.zonelessBasis === "utc";
  const retryAt = new Date(now);
  if (spec.month !== null && spec.day !== null) {
    if (utcBasis) {
      retryAt.setUTCFullYear(spec.year ?? retryAt.getUTCFullYear(), spec.month - 1, spec.day);
      retryAt.setUTCHours(spec.hour, spec.minute, 0, 0);
    } else {
      retryAt.setFullYear(spec.year ?? retryAt.getFullYear(), spec.month - 1, spec.day);
      retryAt.setHours(spec.hour, spec.minute, 0, 0);
    }
    return retryAt;
  }
  if (utcBasis) {
    retryAt.setUTCHours(spec.hour, spec.minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
  } else {
    retryAt.setHours(spec.hour, spec.minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export type ProviderQuotaClassification = {
  errorCode: "provider_quota";
  errorFamily: "provider_quota";
  retryNotBefore: string | null;
  resetAt: Date | null;
};

/**
 * Classify free-form failure text as a provider-quota exhaustion. Returns null
 * for anything else so callers keep their existing classification untouched.
 */
export function classifyProviderQuotaFailure(
  text: string | null | undefined,
  now = new Date(),
): ProviderQuotaClassification | null {
  if (!matchesProviderQuotaText(text)) return null;
  const resetAt = extractProviderQuotaResetAt(text, now);
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: resetAt ? resetAt.toISOString() : null,
    resetAt,
  };
}
