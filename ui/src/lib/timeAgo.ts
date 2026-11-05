import { t } from "../i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return t("relative.justNow", { ns: "formatting" });
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return t("relative.minute", { ns: "formatting", count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return t("relative.hour", { ns: "formatting", count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return t("relative.day", { ns: "formatting", count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return t("relative.week", { ns: "formatting", count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return t("relative.month", { ns: "formatting", count: mo });
}
