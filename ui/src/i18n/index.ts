import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

/** localStorage key for the operator-selected product UI locale. */
export const LOCALE_STORAGE_KEY = "paperclip.locale";

/**
 * Read a persisted locale when it is in the supported catalog.
 * Falls back to {@link DEFAULT_LOCALE} when missing or invalid.
 */
export function readStoredLocale(): string {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)?.trim();
    if (stored && supportedLocales.includes(stored)) return stored;
  } catch {
    // Ignore storage access failures (private mode / blocked storage).
  }
  return DEFAULT_LOCALE;
}

/**
 * Persist and apply a product UI locale when it is supported.
 */
export function setAppLocale(locale: string): void {
  if (!supportedLocales.includes(locale)) return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore persistence failures; still switch the in-memory language.
  }
  void i18n.changeLanguage(locale);
}

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: readStoredLocale(),
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

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, supportedLocales };
