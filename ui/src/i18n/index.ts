import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import {
  DEFAULT_LOCALE,
  i18nextResources,
  isSupportedLocale,
  supportedLocales,
  type SupportedLocale,
} from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

function matchSupportedLocale(candidate: string): SupportedLocale | null {
  const normalized = candidate.trim().replace("_", "-").toLowerCase();
  const exactMatch = supportedLocales.find((locale) => locale.toLowerCase() === normalized);
  if (exactMatch) return exactMatch;
  const baseLanguage = normalized.split("-")[0];
  return supportedLocales.find((locale) => locale.toLowerCase() === baseLanguage) ?? null;
}

export function resolveInitialLocale(): SupportedLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const persisted = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (persisted) {
      const matched = matchSupportedLocale(persisted);
      if (matched) return matched;
    }
  } catch {
    // localStorage unavailable (e.g. hardened privacy settings).
  }

  try {
    const browserLocales = [
      ...(window.navigator?.languages ?? []),
      window.navigator?.language,
    ].filter((locale): locale is string => Boolean(locale));
    for (const locale of browserLocales) {
      const matched = matchSupportedLocale(locale);
      if (matched) return matched;
    }
  } catch {
    // Browser locale unavailable.
  }
  return DEFAULT_LOCALE;
}

const initialLocale = resolveInitialLocale();

function syncDocumentLocale(locale: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
}

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

i18n.on("languageChanged", syncDocumentLocale);
void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function setLocale(locale: string) {
  if (!isSupportedLocale(locale)) return;
  void i18n.changeLanguage(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures.
  }
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, supportedLocales };
