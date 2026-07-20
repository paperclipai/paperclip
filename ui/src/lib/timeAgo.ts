import { i18n } from "@/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return i18n.t("common.justNow");
  const relative = new Intl.RelativeTimeFormat(i18n.resolvedLanguage ?? i18n.language, { numeric: "always" });
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return relative.format(-m, "minute");
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return relative.format(-h, "hour");
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return relative.format(-d, "day");
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return relative.format(-w, "week");
  }
  const mo = Math.floor(seconds / MONTH);
  return relative.format(-mo, "month");
}
