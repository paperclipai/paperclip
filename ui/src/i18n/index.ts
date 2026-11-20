import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { applyDocumentLang, isSelectableLocale, LOCALE_STORAGE_KEY, noteUiLanguageChoice, readStoredLocale } from "./preference";

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

void i18n.use(initReactI18next).init(i18nextOptions).then(() => {
  applyDocumentLang(i18n.resolvedLanguage ?? initialLocale);
}).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY || !isSelectableLocale(event.newValue)) return;
    noteUiLanguageChoice(event.newValue);
    applyDocumentLang(event.newValue);
    void i18n.changeLanguage(event.newValue);
  });
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
