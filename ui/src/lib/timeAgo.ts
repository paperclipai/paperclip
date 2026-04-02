import i18n from "@/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return i18n.t("common:time.justNow");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return i18n.t("common:time.minutesAgo", { count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return i18n.t("common:time.hoursAgo", { count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return i18n.t("common:time.daysAgo", { count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return i18n.t("common:time.weeksAgo", { count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return i18n.t("common:time.monthsAgo", { count: mo });
}
