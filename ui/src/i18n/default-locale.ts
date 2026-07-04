import { DEFAULT_LOCALE, FALLBACK_LOCALE, supportedLocales, type SupportedLocale } from "./locales";

export const DEFAULT_LOCALE_STORAGE_KEY = "paperclip.ui.locale";

type ResolveDefaultLocaleInput = {
  envLocale?: string;
  storedLocale?: string | null;
  navigatorLanguages?: readonly string[];
  defaultLocale?: SupportedLocale;
};

const supportedLocaleSet = new Set<string>(supportedLocales);

function normalizeLocaleTag(locale: string) {
  return locale.trim().replace(/_/g, "-");
}

export function normalizeSupportedLocale(locale: string | null | undefined): SupportedLocale | null {
  if (!locale) return null;

  const normalized = normalizeLocaleTag(locale);
  if (!normalized) return null;
  if (supportedLocaleSet.has(normalized)) return normalized as SupportedLocale;

  const normalizedLower = normalized.toLowerCase();
  const exactCaseInsensitive = supportedLocales.find((candidate) => candidate.toLowerCase() === normalizedLower);
  if (exactCaseInsensitive) return exactCaseInsensitive as SupportedLocale;

  const language = normalizedLower.split("-")[0];
  const languageMatch = supportedLocales.find((candidate) => candidate.toLowerCase().split("-")[0] === language);
  return languageMatch ? (languageMatch as SupportedLocale) : null;
}

export function resolveDefaultLocale({
  envLocale,
  storedLocale,
  navigatorLanguages = [],
  defaultLocale = DEFAULT_LOCALE,
}: ResolveDefaultLocaleInput = {}): SupportedLocale {
  for (const candidate of [envLocale, storedLocale, defaultLocale, ...navigatorLanguages]) {
    const locale = normalizeSupportedLocale(candidate);
    if (locale) return locale;
  }

  return FALLBACK_LOCALE as SupportedLocale;
}

function readStoredLocale() {
  try {
    return globalThis.localStorage?.getItem(DEFAULT_LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function readNavigatorLanguages() {
  try {
    const { languages, language } = globalThis.navigator ?? {};
    return languages?.length ? languages : language ? [language] : [];
  } catch {
    return [];
  }
}

export function resolveInitialLocale(): SupportedLocale {
  return resolveDefaultLocale({
    envLocale: import.meta.env.VITE_PAPERCLIP_DEFAULT_LOCALE,
    storedLocale: readStoredLocale(),
    navigatorLanguages: readNavigatorLanguages(),
  });
}
