/**
 * Reads a provider's "try again at 4:30 PM (America/Chicago)" or
 * "resets 2am (UTC)" wording as the next matching wall-clock instant after
 * `now`. A clock without a time zone is read as UTC.
 */
export function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /(?:try again at|resets?(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (
    meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23
  )
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime())
      retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

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
    const buildRetryAt = (dayOffset: number) => {
      const targetDay = new Date(
        Date.UTC(
          Number(nowParts.year),
          Number(nowParts.month) - 1,
          Number(nowParts.day) + dayOffset,
          hour,
          minute,
        ),
      );
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
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
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}
