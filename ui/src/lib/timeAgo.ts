import { getRuntimeLocale } from "../i18n/runtime";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);
  const formatter = new Intl.RelativeTimeFormat(getRuntimeLocale(), {
    numeric: "auto",
    style: "short",
  });

  if (seconds < MINUTE) return formatter.format(0, "second");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return formatter.format(-m, "minute");
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return formatter.format(-h, "hour");
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return formatter.format(-d, "day");
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return formatter.format(-w, "week");
  }
  const mo = Math.floor(seconds / MONTH);
  return formatter.format(-mo, "month");
}
