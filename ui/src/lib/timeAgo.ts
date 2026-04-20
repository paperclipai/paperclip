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

  if (seconds < MINUTE) return i18n.t("time.just_now");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return i18n.t("time.minutes_ago", { count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return i18n.t("time.hours_ago", { count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return i18n.t("time.days_ago", { count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return i18n.t("time.weeks_ago", { count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return i18n.t("time.months_ago", { count: mo });
}
