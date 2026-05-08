import i18n from "../locales/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string, locale?: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale ?? i18n.language, { numeric: "auto" });
  if (seconds < MINUTE) return rtf.format(-seconds, "second");
  const m = Math.floor(seconds / MINUTE);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.floor(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  const w = Math.floor(d / 7);
  if (w < 5) return rtf.format(-w, "week");
  return rtf.format(-Math.floor(d / 30), "month");
}
