import { GoogleToolError } from "../errors.js";

export interface CivilDate { year: number; month: number; day: number }
export interface CivilTime { hour: number; minute: number; second: number; millisecond: number }
export interface TimeInput { date: CivilDate; time: CivilTime | null; offsetMinutes: number | null }

const DAY_MS = 86_400_000;
const MIDNIGHT: CivilTime = { hour: 0, minute: 0, second: 0, millisecond: 0 };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseTimeInput(value: string, field = "time"): TimeInput {
  const match = ISO.exec(value.trim());
  const invalid = () => new GoogleToolError("invalid_argument", `${field} must be an ISO 8601 date or date-time, such as 2026-04-30T10:00:00.`);
  if (!match) throw invalid();
  const [, y, mo, d, h, mi, s, frac, zulu, sign, oh, om] = match;
  const date = { year: Number(y), month: Number(mo), day: Number(d) };
  if (date.year < 1000 || date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) throw invalid();
  const time = h === undefined ? null : {
    hour: Number(h), minute: Number(mi), second: Number(s ?? 0), millisecond: Number((frac ?? "0").padEnd(3, "0").slice(0, 3)),
  };
  if (time && (time.hour > 23 || time.minute > 59 || time.second > 59)) throw invalid();
  let offsetMinutes: number | null = null;
  if (zulu) offsetMinutes = 0;
  else if (sign) {
    if (Number(oh) > 23 || Number(om) > 59) throw invalid();
    offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  }
  if (offsetMinutes !== null && !time) throw invalid();
  return { date, time, offsetMinutes };
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

function wallClock(instant: number, timeZone: string): { date: CivilDate; time: CivilTime } {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {
    date: { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) },
    time: { hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), millisecond: 0 },
  };
}

function civilMs(date: CivilDate, time: CivilTime): number {
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second, time.millisecond);
}

export function offsetMinutesAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const local = wallClock(whole, timeZone);
  return Math.round((civilMs(local.date, local.time) - whole) / 60_000);
}

export function zonedToInstant(date: CivilDate, time: CivilTime, timeZone: string): number {
  const local = civilMs(date, time);
  const before = offsetMinutesAt(local - DAY_MS, timeZone);
  const after = offsetMinutesAt(local + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => local - offset * 60_000)
    .filter((instant) => offsetMinutesAt(instant, timeZone) * 60_000 === local - instant);
  if (valid.length) return Math.min(...valid);
  return local - before * 60_000;
}

export function instantOf(input: TimeInput, timeZone: string | undefined): number {
  const time = input.time ?? MIDNIGHT;
  if (input.offsetMinutes !== null) return civilMs(input.date, time) - input.offsetMinutes * 60_000;
  if (!timeZone) throw new GoogleToolError("invalid_argument", "A time zone is needed to read a time without a UTC offset.");
  return zonedToInstant(input.date, time, timeZone);
}

export function formatOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function formatDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function formatLocal(date: CivilDate, time: CivilTime): string {
  return `${formatDate(date)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
}

export function formatInZone(instant: number, timeZone: string): string {
  const local = wallClock(instant, timeZone);
  const millisecond = ((instant % 1000) + 1000) % 1000;
  const fraction = millisecond ? `.${pad(millisecond, 3)}` : "";
  return `${formatLocal(local.date, local.time)}${fraction}${formatOffset(offsetMinutesAt(instant, timeZone))}`;
}

export function localDateAt(instant: number, timeZone: string): CivilDate {
  return wallClock(instant, timeZone).date;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

export function compareDates(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

export function daysBetween(start: CivilDate, end: CivilDate): number {
  return Math.round(compareDates(end, start) / DAY_MS);
}

export function weekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function addLocalDays(instant: number, days: number, timeZone: string): number {
  const local = wallClock(instant, timeZone);
  return zonedToInstant(addDays(local.date, days), local.time, timeZone);
}
