/**
 * Auto-schedule helper — ported from agnb lib/agnb/blog-scheduler.ts.
 * Computes the next available publish slot for a new draft given org-level
 * cadence settings + the latest existing scheduled_at. Pure compute.
 */

export interface ScheduleSettings {
  cadence_days: number;
  preferred_dow: number;     // 0-6 (Sun-Sat)
  preferred_hour: number;    // 0-23
  timezone: string;          // IANA tz name
  enabled: boolean;
}

/** Compute next slot in UTC ISO string. */
export function nextSlot(settings: ScheduleSettings, lastScheduledAtIso: string | null): string {
  const now = new Date();
  const minStart = lastScheduledAtIso
    ? new Date(new Date(lastScheduledAtIso).getTime() + settings.cadence_days * 24 * 60 * 60 * 1000)
    : now;

  const earliest = new Date(Math.max(minStart.getTime(), now.getTime() + 60 * 60 * 1000));

  for (let i = 0; i < 14; i++) {
    const candidate = new Date(earliest.getTime() + i * 24 * 60 * 60 * 1000);
    const localParts = getZonedParts(candidate, settings.timezone);
    if (localParts.dow !== settings.preferred_dow) continue;
    return makeZonedDate(localParts.year, localParts.month, localParts.day, settings.preferred_hour, 0, settings.timezone);
  }

  const fallback = new Date(earliest.getTime() + settings.cadence_days * 24 * 60 * 60 * 1000);
  const fp = getZonedParts(fallback, settings.timezone);
  return makeZonedDate(fp.year, fp.month, fp.day, settings.preferred_hour, 0, settings.timezone);
}

function getZonedParts(d: Date, tz: string): { year: number; month: number; day: number; dow: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dow: dowMap[parts.weekday] ?? 0,
    hour: Number(parts.hour),
  };
}

/** Construct ISO UTC timestamp for a wall-clock time in the given timezone. */
function makeZonedDate(year: number, month: number, day: number, hour: number, minute: number, tz: string): string {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMs = guess.getTime() - new Date(guess.toLocaleString("en-US", { timeZone: tz })).getTime();
  return new Date(guess.getTime() + offsetMs).toISOString();
}
