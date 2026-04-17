import enMessages from "../locales/en.json";
import zhCnMessages from "../locales/zh-CN.json";

export const supportedLocales = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;
export type MessageKey = keyof typeof enMessages;

type MessageCatalog = Record<MessageKey, string>;

const defaultLocale: SupportedLocale = "en";
const intlLocaleBySupportedLocale: Record<SupportedLocale, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
};
const messageCatalogs: Record<SupportedLocale, MessageCatalog> = {
  en: enMessages,
  "zh-CN": zhCnMessages,
};

let currentLocale: SupportedLocale = defaultLocale;

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (!locale) return defaultLocale;
  const normalized = locale.trim().toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  return "en";
}

export function setCurrentLocale(locale: string | null | undefined): SupportedLocale {
  currentLocale = normalizeLocale(locale);
  return currentLocale;
}

export function getCurrentLocale(): SupportedLocale {
  return currentLocale;
}

export function getCurrentIntlLocale(locale: string | null | undefined = currentLocale): string {
  return intlLocaleBySupportedLocale[normalizeLocale(locale)];
}

function interpolateMessage(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}

export function translate(
  key: MessageKey,
  options: {
    locale?: string | null | undefined;
    fallback?: string;
    values?: TranslationValues;
  } = {},
): string {
  const locale = normalizeLocale(options.locale);
  const message = messageCatalogs[locale][key]
    ?? messageCatalogs[defaultLocale][key]
    ?? options.fallback
    ?? key;
  return interpolateMessage(message, options.values);
}

export function formatDate(date: Date | string, locale: string | null | undefined = currentLocale): string {
  return new Date(date).toLocaleDateString(getCurrentIntlLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(date: Date | string, locale: string | null | undefined = currentLocale): string {
  return new Date(date).toLocaleString(getCurrentIntlLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatShortDate(date: Date | string, locale: string | null | undefined = currentLocale): string {
  return new Date(date).toLocaleString(getCurrentIntlLocale(locale), {
    month: "short",
    day: "numeric",
  });
}

export function relativeTime(date: Date | string, locale: string | null | undefined = currentLocale): string {
  const resolvedLocale = normalizeLocale(locale);
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);

  if (diffSec < 60) {
    return translate("relativeTime.justNow", { locale: resolvedLocale, fallback: "just now" });
  }

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return translate("relativeTime.minutesAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}m ago",
      values: { count: diffMin },
    });
  }

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) {
    return translate("relativeTime.hoursAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}h ago",
      values: { count: diffHr },
    });
  }

  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) {
    return translate("relativeTime.daysAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}d ago",
      values: { count: diffDay },
    });
  }

  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) {
    return translate("relativeTime.weeksAgo", {
      locale: resolvedLocale,
      fallback: "{{count}}w ago",
      values: { count: diffWeek },
    });
  }

  const diffMonth = Math.round(diffDay / 30);
  return translate("relativeTime.monthsAgo", {
    locale: resolvedLocale,
    fallback: "{{count}}mo ago",
    values: { count: diffMonth },
  });
}
