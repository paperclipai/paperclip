import { DEFAULT_LOCALE, localeMessages, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

export function normalizeBrowserLocale(
  tag: string | null | undefined,
  available: readonly string[] = supportedLocales,
): string {
  if (!tag) return DEFAULT_LOCALE;
  const normalized = tag.trim().replaceAll("_", "-");
  if (!normalized) return DEFAULT_LOCALE;

  const availableSet = new Set(available);
  if (availableSet.has(normalized)) return normalized;

  const lower = normalized.toLowerCase();
  const caseInsensitive = available.find((item) => item.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive;

  const [language, region] = lower.split("-");
  if (language === "zh") {
    if (region === "tw" || region === "hk" || region === "mo" || region === "hant") {
      return availableSet.has("zh-TW") ? "zh-TW" : DEFAULT_LOCALE;
    }
    return availableSet.has("zh-CN") ? "zh-CN" : DEFAULT_LOCALE;
  }

  const exactLanguage = available.find((item) => item.toLowerCase() === language);
  if (exactLanguage) return exactLanguage;
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistLocale(locale: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode failures; the session language still changes.
  }
}

export function resolveInitialLocale(input?: {
  stored?: string | null;
  navigatorLanguage?: string | null;
  mode?: string;
}): string {
  const mode = input?.mode ?? import.meta.env.MODE;
  if (mode === "test") return DEFAULT_LOCALE;

  const stored = input?.stored === undefined ? readStoredLocale() : input.stored;
  if (stored && stored in localeMessages) return stored;

  const navigatorLanguage =
    input?.navigatorLanguage === undefined
      ? typeof navigator === "undefined"
        ? null
        : navigator.language
      : input.navigatorLanguage;
  return normalizeBrowserLocale(navigatorLanguage);
}
