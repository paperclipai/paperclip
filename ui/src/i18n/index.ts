import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

function resolveInitialLocale(): string {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const persisted = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (persisted && supportedLocales.includes(persisted)) return persisted;
    const navigatorLocale = window.navigator?.language?.toLowerCase();
    if (navigatorLocale) {
      const exactMatch = supportedLocales.find((locale) => locale.toLowerCase() === navigatorLocale);
      if (exactMatch) return exactMatch;
      const baseLanguage = navigatorLocale.split(/[-_]/)[0];
      const baseMatch = supportedLocales.find((locale) => locale.toLowerCase() === baseLanguage);
      if (baseMatch) return baseMatch;
    }
  } catch {
    // localStorage/navigator unavailable (e.g. hardened privacy settings).
  }
  return DEFAULT_LOCALE;
}

const initialLocale = resolveInitialLocale();

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
  void i18n.changeLanguage(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures.
  }
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, supportedLocales };
