import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

const LOCALE_STORAGE_KEY = "paperclip.locale";

function readStoredLocale(): string {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && supportedLocales.includes(stored)) return stored;
  } catch {
    // localStorage may be unavailable (e.g. private mode); fall back silently.
  }
  return DEFAULT_LOCALE;
}

const initialLocale = readStoredLocale();

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

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function setLocale(locale: string) {
  if (!supportedLocales.includes(locale)) return;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
  }
  void i18n.changeLanguage(locale);
}

export function getLocale(): string {
  return i18n.language || DEFAULT_LOCALE;
}

export { LOCALE_STORAGE_KEY, supportedLocales };
export const useTranslation = useReactI18nextTranslation;
export { i18n };
