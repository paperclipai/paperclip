import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
  detection: {
    order: ["localStorage", "navigator"],
    lookupLocalStorage: "paperclip_locale",
    caches: ["localStorage"],
  },
};

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init(i18nextOptions)
  .catch((error: unknown) => {
    console.error("Failed to initialize i18next", error);
  });

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function changeLanguage(lng: string) {
  localStorage.setItem("paperclip_locale", lng);
  void i18n.changeLanguage(lng);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
