import { messages, type Locale, type MessageKey } from "../locales";

export type { Locale, MessageKey };

export type TranslationParams = Record<string, string | number>;

export const LOCALE_STORAGE_KEY = "paperclip.locale";
export const DEFAULT_LOCALE: Locale = "en";

let activeLocale: Locale = DEFAULT_LOCALE;

// ---------------------------------------------------------------------------
// Locale utilities
// ---------------------------------------------------------------------------

export function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === "string" && value in messages;
}

export function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Ignore storage failures.
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function getLocaleToggleTarget(locale: Locale): Locale {
  return locale === "en" ? "zh-CN" : "en";
}

// ---------------------------------------------------------------------------
// Plural resolution
// ---------------------------------------------------------------------------

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function resolvePluralKey(locale: Locale, baseKey: string, count: number): string {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  const category = rules.select(count);
  const candidateKey = `${baseKey}_${category}`;
  const localeMessages = messages[locale] ?? messages.en;
  if (candidateKey in localeMessages) return candidateKey;
  const otherKey = `${baseKey}_other`;
  if (otherKey in localeMessages) return otherKey;
  return baseKey;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? ""));
}

export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  const resolvedKey =
    params != null && typeof params.count === "number"
      ? resolvePluralKey(locale, key, params.count)
      : key;

  const template =
    (messages[locale] as Record<string, string>)[resolvedKey] ??
    (messages.en as Record<string, string>)[resolvedKey] ??
    resolvedKey;

  if (
    import.meta.env.DEV &&
    (messages[locale] as Record<string, string>)[resolvedKey] === undefined &&
    (messages.en as Record<string, string>)[resolvedKey] === undefined
  ) {
    console.warn(`[i18n] Missing translation key: "${resolvedKey}" (locale: ${locale})`);
  }

  return interpolate(template, params);
}

export function translateActive(key: string, params?: TranslationParams): string {
  return translate(activeLocale, key, params);
}

// ---------------------------------------------------------------------------
// Formatting — locale-aware Intl wrappers
// ---------------------------------------------------------------------------

export function formatDate(locale: Locale, date: Date | string): string {
  return new Date(date).toLocaleDateString(
    locale,
    locale === "zh-CN"
      ? { year: "numeric", month: "numeric", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

export function formatDateTime(locale: Locale, date: Date | string): string {
  return new Date(date).toLocaleString(
    locale,
    locale === "zh-CN"
      ? {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
  );
}

export function formatShortDate(locale: Locale, date: Date | string): string {
  return new Date(date).toLocaleString(
    locale,
    locale === "zh-CN"
      ? { month: "numeric", day: "numeric" }
      : { month: "short", day: "numeric" },
  );
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatCurrency(locale: Locale, cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatRelativeTime(locale: Locale, date: Date | string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { style: "short", numeric: "always" });
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((then - now) / 1000); // negative = past
  const absSec = Math.abs(diffSec);

  if (absSec < 60) return rtf.format(diffSec, "second");
  const diffMin = Math.round(diffSec / 60);
  const absMin = Math.abs(diffMin);
  if (absMin < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  const absHr = Math.abs(diffHr);
  if (absHr < 24) return rtf.format(diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  const absDay = Math.abs(diffDay);
  if (absDay < 7) return rtf.format(diffDay, "day");
  const diffWeek = Math.round(diffDay / 7);
  const absWeek = Math.abs(diffWeek);
  if (absWeek < 4) return rtf.format(diffWeek, "week");
  const diffMonth = Math.round(diffDay / 30);
  const absMonth = Math.abs(diffMonth);
  if (absMonth < 12) return rtf.format(diffMonth, "month");

  // Fall back to absolute date for anything older than 12 months
  return formatDate(locale, date);
}
