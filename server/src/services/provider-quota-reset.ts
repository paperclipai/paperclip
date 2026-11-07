const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?";
const CLOCK = "(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?\\s*m\\.?)?(?:\\s*\\(([^)]+)\\)|\\s+([A-Z]{2,5}))?";
const DATED_RESET_RE = new RegExp(
  `(?:try again at|resets?(?:\\s+on)?)\\s+${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?,?\\s+(?:at\\s+)?${CLOCK}`,
  "i",
);
const CLOCK_RESET_RE = new RegExp(`(?:try again at|resets?(?:\\s+at)?)\\s+${CLOCK}`, "i");
const DAY_MS = 24 * 60 * 60_000;
/** A dated reset slightly in the past is a stale notice, not next year's. */
const DATED_RESET_PAST_GRACE_MS = 7 * DAY_MS;
/** Allowance periods are at most a month; a later date is not this limit's reset. */
const DATED_RESET_MAX_AHEAD_MS = 45 * DAY_MS;

/**
 * Reads a provider's "try again at 4:30 PM (America/Chicago)",
 * "resets 2am (UTC)", or dated "resets Nov 10, 3pm (UTC)" wording. A clock
 * is the next matching wall-clock instant after `now`; a date without a year
 * is its nearest occurrence. A clock without a time zone is read as UTC.
 */
export function parseProviderQuotaClockReset(error: string, now: Date) {
  const dated = error.match(DATED_RESET_RE);
  if (dated) return parseDatedReset(dated, now);
  const match = error.match(CLOCK_RESET_RE);
  if (!match) return null;
  const clock = readClock(match.slice(1));
  if (!clock) return null;
  const { hour, minute, timeZone } = clock;
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime())
      retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const nowParts = wallClock(now, timeZone);
    const buildRetryAt = (dayOffset: number) =>
      zonedInstant(timeZone, nowParts.year, nowParts.month - 1, nowParts.day + dayOffset, hour, minute);
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}

function parseDatedReset(match: RegExpMatchArray, now: Date) {
  const month = monthIndex(match[1] ?? "");
  const day = Number.parseInt(match[2] ?? "", 10);
  const statedYear = match[3] ? Number.parseInt(match[3], 10) : null;
  const clock = readClock(match.slice(4));
  if (month < 0 || !clock) return null;
  const { hour, minute, timeZone } = clock;
  try {
    const at = (year: number) => {
      // Reject a day that does not exist in that month, such as Apr 31.
      const date = new Date(Date.UTC(year, month, day));
      if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
      return timeZone
        ? zonedInstant(timeZone, year, month, day, hour, minute)
        : new Date(Date.UTC(year, month, day, hour, minute));
    };
    let retryAt: Date | null;
    if (statedYear !== null) {
      retryAt = at(statedYear);
    } else {
      const year = timeZone ? wallClock(now, timeZone).year : now.getUTCFullYear();
      retryAt = at(year);
      if (retryAt && retryAt.getTime() < now.getTime() - DATED_RESET_PAST_GRACE_MS) retryAt = at(year + 1);
    }
    if (!retryAt || retryAt.getTime() > now.getTime() + DATED_RESET_MAX_AHEAD_MS) return null;
    return retryAt;
  } catch {
    return null;
  }
}

function readClock(groups: Array<string | undefined>) {
  const hourValue = Number.parseInt(groups[0] ?? "", 10);
  const minute = Number.parseInt(groups[1] ?? "0", 10);
  const meridiem = (groups[2] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (
    meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23
  )
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  return { hour, minute, timeZone: (groups[3] ?? groups[4])?.trim() };
}

function monthIndex(name: string) {
  const prefix = name.slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(prefix);
}

/** Throws a RangeError for an unknown time zone. */
function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
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
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The instant whose wall clock in `timeZone` reads the given local time. */
function zonedInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number) {
  const targetMs = Date.UTC(year, month, day, hour, minute);
  let candidate = new Date(targetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = wallClock(candidate, timeZone);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = targetMs - actualMs;
    if (adjustment === 0) break;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}
