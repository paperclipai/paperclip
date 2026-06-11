import { DEFAULT_LOCALE, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

function matchSupportedLocale(candidate: string): string | null {
  if (supportedLocales.includes(candidate)) return candidate;

  const baseLanguage = candidate.split("-")[0];
  if (!baseLanguage) return null;
  if (supportedLocales.includes(baseLanguage)) return baseLanguage;

  const regionalVariant = supportedLocales.find((locale) => locale.startsWith(`${baseLanguage}-`));
  return regionalVariant ?? null;
}

export function getStoredLocale(): string | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!stored) return null;
    return matchSupportedLocale(stored);
  } catch {
    return null;
  }
}

export function storeLocale(locale: string) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Persisting the preference is best-effort; ignore storage failures.
  }
}

function browserLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export function resolveInitialLocale(): string {
  const stored = getStoredLocale();
  if (stored) return stored;

  for (const candidate of browserLocales()) {
    const matched = matchSupportedLocale(candidate);
    if (matched) return matched;
  }

  return DEFAULT_LOCALE;
}
