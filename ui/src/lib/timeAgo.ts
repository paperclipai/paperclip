import { t } from "../i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

function getTimeSuffix(key: string, count: number): string {
  const translated = t(key, { count });
  return translated.replace("{{count}}", String(count));
}

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return t("common.time.justNow");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return getTimeSuffix("common.time.minutesAgo", m);
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return getTimeSuffix("common.time.hoursAgo", h);
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return getTimeSuffix("common.time.daysAgo", d);
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return getTimeSuffix("common.time.weeksAgo", w);
  }
  const mo = Math.floor(seconds / MONTH);
  return getTimeSuffix("common.time.monthsAgo", mo);
}
