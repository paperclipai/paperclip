const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET_PATTERN = new RegExp(
  "(?:try again at|resets?(?:\\s+(?:at|on))?)\\s+" +
    // Optional calendar date, as in "resets Nov 12, 6pm (UTC)" for a weekly limit.
    `(?:(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:at\\s+)?)?` +
    "(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?\\s*m\\.?)?(?:\\s*\\(([^)]+)\\)|\\s+([A-Z]{2,5}))?",
  "i",
);

/**
 * Reads a provider's "try again at 4:30 PM (America/Chicago)", "resets 2am
 * (UTC)" or "resets Nov 12, 6pm (UTC)" wording. A clock alone is the next
 * matching wall-clock instant after `now`; a calendar date is that day (this
 * year, or next year once the date has passed). A clock without a time zone is
 * read as UTC.
 */
export function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(RESET_PATTERN);
  if (!match) return null;

  const monthIndex = match[1] ? MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) : null;
  const dayOfMonth = match[2] ? Number.parseInt(match[2], 10) : null;
  if (monthIndex !== null && (monthIndex < 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)) return null;
  const hourValue = Number.parseInt(match[3] ?? "", 10);
  const minute = Number.parseInt(match[4] ?? "0", 10);
  const meridiem = (match[5] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (
    meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23
  )
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[6] ?? match[7])?.trim() || "UTC";

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
      const thisYear = instant(year, monthIndex, dayOfMonth);
      if (!thisYear) return null;
      // A reset reported for a date already past by more than a day rolls into
      // next year ("resets Jan 2" read on Dec 30).
      return thisYear.getTime() >= now.getTime() - 24 * 60 * 60_000
        ? thisYear
        : instant(year + 1, monthIndex, dayOfMonth);
    }
    const month = Number(nowParts.month) - 1;
    const day = Number(nowParts.day);
    const sameDay = instant(year, month, day)!;
    return sameDay.getTime() > now.getTime() ? sameDay : instant(year, month, day + 1);
  } catch {
    return null;
  }
}
