import { z } from "zod";

const HM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ActiveHoursWindow {
  start: string;
  end: string;
  timezone: string;
}

export function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function parseHmToMinutes(value: string): number | null {
  const match = HM_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const activeHoursWindowSchema = z.object({
  start: z.string().regex(HM_PATTERN),
  end: z.string().regex(HM_PATTERN),
  timezone: z.string().trim().min(1).refine(isValidTimeZone, { message: "Invalid timezone identifier" }),
});

const MINUTES_PER_DAY = 24 * 60;
const MAX_CACHED_FORMATTERS = 512;

const localTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function localTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = localTimeFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  if (localTimeFormatters.size >= MAX_CACHED_FORMATTERS) localTimeFormatters.clear();
  localTimeFormatters.set(timezone, formatter);
  return formatter;
}

function localMinuteOfDay(timezone: string, at: Date): number {
  const parts = localTimeFormatter(timezone).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function isMinuteInside(current: number, start: number, end: number): boolean {
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/**
 * Earliest minute at or after `from` that falls inside the window, or null when
 * the window never opens (for example start === end). Scans at most two days.
 */
export function nextActiveHoursStart(
  window: ActiveHoursWindow,
  from: Date,
): Date | null {
  const minuteMs = 60_000;
  const first = Math.ceil(from.getTime() / minuteMs) * minuteMs;
  const start = parseHmToMinutes(window.start);
  const end = parseHmToMinutes(window.end);
  if (start == null || end == null) return new Date(first);
  if (start === end) return null;

  const current = localMinuteOfDay(window.timezone, new Date(first));
  if (isMinuteInside(current, start, end)) return new Date(first);

  // Local time runs evenly until the next start unless a clock change falls in
  // the wait, so landing exactly on the start proves nothing opened earlier.
  const untilStart = (start - current + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const opening = new Date(first + untilStart * minuteMs);
  if (localMinuteOfDay(window.timezone, opening) === start) return opening;

  // A clock change can skip the start or repeat an open stretch, so check each minute.
  for (let offset = 1; offset <= 2 * MINUTES_PER_DAY; offset += 1) {
    const candidate = new Date(first + offset * minuteMs);
    if (isMinuteInside(localMinuteOfDay(window.timezone, candidate), start, end)) return candidate;
  }
  return null;
}

export function isWithinActiveHours(
  window: ActiveHoursWindow | null | undefined,
  now: Date,
): boolean {
  if (!window) return true;
  const start = parseHmToMinutes(window.start);
  const end = parseHmToMinutes(window.end);
  if (start == null || end == null) return true;
  return isMinuteInside(localMinuteOfDay(window.timezone, now), start, end);
}
