import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { resolveInitialLocale, storeLocale } from "./persistence";

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

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function setLocale(locale: string) {
  if (!supportedLocales.includes(locale)) return;
  storeLocale(locale);
  void i18n.changeLanguage(locale).catch((error: unknown) => {
    console.error(`Failed to change language to ${locale}`, error);
  });
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
export { supportedLocales } from "./locales";
export { localeDisplayName } from "./locale-names";
