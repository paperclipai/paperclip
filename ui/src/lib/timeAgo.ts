import i18n from "../i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  const t = i18n.t.bind(i18n);

  if (seconds < MINUTE) return t("common:timeAgo.justNow");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return t("common:timeAgo.minutesAgo", { m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return t("common:timeAgo.hoursAgo", { h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return t("common:timeAgo.daysAgo", { d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return t("common:timeAgo.weeksAgo", { w });
  }
  const mo = Math.floor(seconds / MONTH);
  return t("common:timeAgo.monthsAgo", { mo });
}
