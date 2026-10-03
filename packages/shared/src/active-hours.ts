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

export function isWithinActiveHours(
  window: ActiveHoursWindow | null | undefined,
  now: Date,
): boolean {
  if (!window) return true;
  const start = parseHmToMinutes(window.start);
  const end = parseHmToMinutes(window.end);
  if (start == null || end == null) return true;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  return start <= end ? current >= start && current < end : current >= start || current < end;
}
