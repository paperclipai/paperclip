import { getCurrentLocale, normalizeLocale, translate } from "@/i18n/runtime";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string, locale: string | null | undefined = getCurrentLocale()): string {
  const resolvedLocale = normalizeLocale(locale);
  const now = Date.now();
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) {
    return translate("relativeTime.justNow", { locale: resolvedLocale, fallback: "just now" });
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));

  if (seconds < MINUTE) {
    return translate("relativeTime.justNow", { locale: resolvedLocale, fallback: "just now" });
  }
  if (seconds < HOUR) {
    return translate("relativeTime.minutesAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}m ago",
      values: { count: Math.floor(seconds / MINUTE) },
    });
  }
  if (seconds < DAY) {
    return translate("relativeTime.hoursAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}h ago",
      values: { count: Math.floor(seconds / HOUR) },
    });
  }
  if (seconds < WEEK) {
    return translate("relativeTime.daysAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}d ago",
      values: { count: Math.floor(seconds / DAY) },
    });
  }
  if (seconds < MONTH) {
    return translate("relativeTime.weeksAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}w ago",
      values: { count: Math.floor(seconds / WEEK) },
    });
  }
  return translate("relativeTime.monthsAgo", {
    locale: resolvedLocale,
    fallback: "{{count}}mo ago",
    values: { count: Math.floor(seconds / MONTH) },
  });
}
