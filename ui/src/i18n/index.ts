import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

function detectLocale(): string {
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ];
  for (const lang of candidates) {
    if (!lang) continue;
    // Exact match (e.g. "pt-BR")
    if (supportedLocales.includes(lang)) return lang;
    // Base language match (e.g. "tr-TR" → "tr")
    const base = lang.split("-")[0];
    if (base && supportedLocales.includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: detectLocale(),
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
export { i18n };
