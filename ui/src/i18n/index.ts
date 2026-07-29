import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export { DEFAULT_LOCALE, supportedLocales };

export const LOCALE_STORAGE_KEY = "paperclip:locale";

const PRIMARY_LOCALE_PREFERENCES: Record<string, string[]> = {
  pt: ["pt-BR", "pt-PT"],
  zh: ["zh-CN", "zh-TW"],
};

function canonicalizeLocale(locale: string): string {
  const normalized = locale.trim().replaceAll("_", "-");
  if (!normalized) return "";

  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? normalized;
  } catch {
    return normalized;
  }
}

/** Resolve a browser or stored BCP-47 tag to one of Paperclip's bundled locales. */
export function matchSupportedLocale(rawLocale: string): string | null {
  const canonical = canonicalizeLocale(rawLocale);
  if (!canonical) return null;

  const lower = canonical.toLowerCase();
  const exact = supportedLocales.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;

  const subtags = lower.split("-");
  const primary = subtags[0] ?? "";

  if (primary === "zh") {
    const prefersTraditional =
      subtags.includes("hant") || subtags.some((subtag) => ["tw", "hk", "mo"].includes(subtag));
    const preferred = prefersTraditional ? "zh-TW" : "zh-CN";
    if (supportedLocales.includes(preferred)) return preferred;
  }

  if (supportedLocales.includes(primary)) return primary;

  for (const preferred of PRIMARY_LOCALE_PREFERENCES[primary] ?? []) {
    if (supportedLocales.includes(preferred)) return preferred;
  }

  return supportedLocales.find((locale) => locale.toLowerCase().split("-")[0] === primary) ?? null;
}

interface PreferredLocaleInput {
  browserLocales?: readonly string[];
  storedLocale?: string | null;
}

/** Choose an initial locale without depending on browser globals, so the policy stays testable. */
export function detectPreferredLocale({
  browserLocales = [],
  storedLocale,
}: PreferredLocaleInput): string {
  if (storedLocale) {
    const matchedStoredLocale = matchSupportedLocale(storedLocale);
    if (matchedStoredLocale) return matchedStoredLocale;
  }

  for (const browserLocale of browserLocales) {
    const matchedBrowserLocale = matchSupportedLocale(browserLocale);
    if (matchedBrowserLocale) return matchedBrowserLocale;
  }

  return DEFAULT_LOCALE;
}

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function browserLocales(): string[] {
  if (typeof navigator === "undefined") return [];
  return Array.from(new Set([...(navigator.languages ?? []), navigator.language].filter(Boolean)));
}

function syncDocumentLocale(locale: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

const initialLocale = detectPreferredLocale({
  storedLocale: readStoredLocale(),
  browserLocales: browserLocales(),
});

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

syncDocumentLocale(initialLocale);

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/** Apply and persist an interface locale, falling back safely when input is unsupported. */
export async function setLocale(rawLocale: string): Promise<string> {
  const locale = matchSupportedLocale(rawLocale) ?? DEFAULT_LOCALE;
  await i18n.changeLanguage(locale);
  writeStoredLocale(locale);
  syncDocumentLocale(locale);
  return locale;
}

export function getLocaleDisplayName(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], {
      type: "language",
      languageDisplay: "standard",
    }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
