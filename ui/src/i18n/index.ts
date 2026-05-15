import { DEFAULT_LOCALE, localeMessages, type SupportedLocale } from "./locales";

let currentLocale: string = DEFAULT_LOCALE;

export function setLocale(locale: string) {
  if (locale in localeMessages) {
    currentLocale = locale;
    localStorage.setItem("paperclip.language", locale);
  }
}

export function getLocale(): string {
  return currentLocale;
}

export function getAvailableLocales(): string[] {
  return Object.keys(localeMessages);
}

function getInitialLocale(): string {
  const stored = localStorage.getItem("paperclip.language");
  if (stored && stored in localeMessages) {
    return stored;
  }
  const browserLang = navigator.language.split("-")[0];
  if (browserLang in localeMessages) {
    return browserLang;
  }
  return DEFAULT_LOCALE;
}

type TranslationOptions = {
  defaultValue?: string;
  [key: string]: string | number | undefined;
};

function resolveLocaleValue(key: string, locale: string) {
  const path = key.split(".");
  let value: unknown = localeMessages[locale];

  for (const segment of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === "string" ? value : null;
}

function interpolate(value: string, options: Record<string, string | number>) {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, name) => {
    const replacement = options[name];
    return replacement !== undefined ? String(replacement) : _match;
  });
}

export function t(key: string, options: TranslationOptions = {}) {
  const { defaultValue, ...vars } = options;
  const raw = resolveLocaleValue(key, currentLocale) ?? resolveLocaleValue(key, DEFAULT_LOCALE) ?? defaultValue ?? key;
  if (typeof raw !== "string") return String(raw);
  return Object.keys(vars).length > 0 ? interpolate(raw, vars as Record<string, string | number>) : raw;
}

export function useTranslation() {
  return { t, locale: currentLocale, setLocale, getAvailableLocales };
}

// Initialize locale from storage or browser
const initialLocale = getInitialLocale();
if (initialLocale !== currentLocale) {
  currentLocale = initialLocale;
}
