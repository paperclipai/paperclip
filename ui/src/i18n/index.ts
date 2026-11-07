import { createInstance, type i18n as I18n, type InitOptions, type TOptions } from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources } from "./locales";
import { isSelectableLocale, readLocalePreference, selectableLocales, writeLocalePreference } from "./locale-preference";

const i18n: I18n = createInstance();

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: readLocalePreference(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...selectableLocales],
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

i18n.on("languageChanged", (locale: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (isSelectableLocale(locale)) writeLocalePreference(locale);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export { Trans, useTranslation } from "react-i18next";
export { i18n };
