import { t } from "@/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return t("time.justNow", { defaultValue: "just now" });
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return t("time.weeksAgo", { defaultValue: "{{count}}w ago", count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return t("time.monthsAgo", { defaultValue: "{{count}}mo ago", count: mo });
}
