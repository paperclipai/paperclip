const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MAX_DATED_RESET_AHEAD_MS = 45 * 24 * 60 * 60_000;
const RESET_PATTERN = new RegExp(
  "(?:try again at|resets?(?:\\s+(?:at|on))?)\\s+" +
    // Optional calendar date, as in "resets Nov 12, 6pm (UTC)" for a weekly limit.
    `(?:(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?,?\\s+(?:at\\s+)?)?` +
    "(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?\\s*m\\.?)?(?![\\d:])(?:\\s*\\(([^)]+)\\)|\\s+([A-Z]{2,5}))?",
  "i",
);

/**
 * Reads a provider's "try again at 4:30 PM (America/Chicago)", "resets 2am
 * (UTC)" or "resets Nov 12, 6pm (UTC)" wording. A clock alone is the next
 * matching wall-clock instant after `now`; a calendar date is its occurrence
 * nearest `now`, which is in the past when the reset already passed. A clock
 * without a time zone is read as UTC.
 */
export function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(RESET_PATTERN);
  if (!match) return null;

  const monthIndex = match[1] ? MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) : null;
  const dayOfMonth = match[2] ? Number.parseInt(match[2], 10) : null;
  const statedYear = match[3] ? Number.parseInt(match[3], 10) : null;
  if (monthIndex !== null && (monthIndex < 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)) return null;
  const hourValue = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  const meridiem = (match[6] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (
    meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23
  )
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[7] ?? match[8])?.trim() || "UTC";

  try {
    const wallClock = (date: Date) =>
      Object.fromEntries(
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
    const nowParts = wallClock(now);
    // The instant whose wall clock in `timeZone` reads this date and time.
    const instant = (year: number, month: number, day: number) => {
      const target = new Date(Date.UTC(year, month, day, hour, minute));
      // Reject dates that overflow, such as Nov 31.
      if (monthIndex !== null && target.getUTCDate() !== day) return null;
      let candidate = target;
      const targetMs = target.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const year = Number(nowParts.year);
    if (monthIndex !== null && dayOfMonth !== null) {
      // The occurrence of that date nearest `now`: "resets Jan 2" read on
      // Dec 30 is next year's. A date read after it passed stays in the past,
      // so a caller reading an old message sees an expired reset rather than
      // one a year away.
      const candidates = (statedYear === null ? [year - 1, year, year + 1] : [statedYear])
        .map((candidateYear) => instant(candidateYear, monthIndex, dayOfMonth))
        .filter((candidate): candidate is Date => candidate !== null);
      if (!candidates.length) return null;
      const nearest = candidates.reduce((nearest, candidate) =>
        Math.abs(candidate.getTime() - now.getTime()) < Math.abs(nearest.getTime() - now.getTime()) ? candidate : nearest);
      return nearest.getTime() > now.getTime() + MAX_DATED_RESET_AHEAD_MS ? null : nearest;
    }
    const month = Number(nowParts.month) - 1;
    const day = Number(nowParts.day);
    const sameDay = instant(year, month, day)!;
    return sameDay.getTime() > now.getTime() ? sameDay : instant(year, month, day + 1);
  } catch {
    return null;
  }
}
