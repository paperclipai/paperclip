import i18n from "@/i18n";

/**
 * Locale-aware date formatting. Replaces hardcoded "en-US" with the active i18n language.
 */
export function formatDateLocale(date: Date | string): string {
  return new Date(date).toLocaleDateString(i18n.language, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTimeLocale(date: Date | string): string {
  return new Date(date).toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Locale-aware relative time using translation keys.
 */
export function relativeTimeLocale(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return i18n.t("time.just_now");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return i18n.t("time.minutes_ago", { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return i18n.t("time.hours_ago", { count: diffHr });
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return i18n.t("time.days_ago", { count: diffDay });
  return formatDateLocale(date);
}

/**
 * Locale-aware timeAgo (same as relativeTimeLocale but with week/month granularity).
 */
export function timeAgoLocale(date: Date | string): string {
  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;

  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < MINUTE) return i18n.t("time.just_now");
  if (seconds < HOUR) return i18n.t("time.minutes_ago", { count: Math.floor(seconds / MINUTE) });
  if (seconds < DAY) return i18n.t("time.hours_ago", { count: Math.floor(seconds / HOUR) });
  if (seconds < WEEK) return i18n.t("time.days_ago", { count: Math.floor(seconds / DAY) });
  if (seconds < MONTH) return i18n.t("time.weeks_ago", { count: Math.floor(seconds / WEEK) });
  return i18n.t("time.months_ago", { count: Math.floor(seconds / MONTH) });
}

/**
 * Locale-aware currency formatting.
 */
export function formatCentsLocale(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Locale-aware compact number formatting (e.g. 1.5M, 42.3k).
 */
export function formatTokensLocale(n: number): string {
  return new Intl.NumberFormat(i18n.language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/**
 * Translate a status key to a display label via i18n.
 * Falls back to humanized form if no translation key exists.
 */
export function statusLabel(status: string): string {
  const key = `status.${status}`;
  const translated = i18n.t(key, { defaultValue: "" });
  if (translated) return translated;
  // Fallback: snake_case/kebab-case to Title Case
  return status
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
