import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import {
  browserLanguages,
  readStoredLocale,
  resolveInitialLocale,
  selectableLocales,
  writeStoredLocale,
} from "./locale-preference";

export const availableLocales = selectableLocales();

const initialLocale = resolveInitialLocale({
  stored: readStoredLocale(),
  languages: browserLanguages(),
  available: availableLocales,
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

function syncDocumentLanguage(locale: string) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

i18n.on("languageChanged", syncDocumentLanguage);

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export async function setLocale(locale: string) {
  if (!availableLocales.includes(locale)) return;
  writeStoredLocale(locale);
  await i18n.changeLanguage(locale);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
