import i18n, { type InitOptions, type TOptions } from "i18next";
import { Trans, initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, LOCALE_STORAGE_KEY, resolveInitialLocale, supportedLocales, type SupportedLocale } from "./locales";

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: resolveInitialLocale(),
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

/** Persist the user's locale preference and switch the active language. */
export function setLocale(locale: string) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode); switching still applies for
    // the session.
  }
  void i18n.changeLanguage(locale);
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { Trans, i18n };
