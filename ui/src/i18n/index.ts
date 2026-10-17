import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export function resolveInitialLocale(): string {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem("paperclip.locale");
      if (saved && supportedLocales.includes(saved)) {
        return saved;
      }
    } catch {
      // Storage access can throw when cookies/storage are blocked.
    }
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    const nav = navigator.language;
    if (supportedLocales.includes(nav)) return nav;
    if (nav.startsWith("pt") && supportedLocales.includes("pt-BR")) return "pt-BR";
    const base = nav.split("-")[0];
    if (supportedLocales.includes(base)) return base;
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

export function changeLanguage(locale: string) {
  if (supportedLocales.includes(locale)) {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("paperclip.locale", locale);
      } catch {
        // Storage access may be blocked; language still switches in-memory for this session.
      }
    }
    void i18n.changeLanguage(locale);
  }
}

export function getCurrentLocale(): string {
  return i18n.language || DEFAULT_LOCALE;
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, supportedLocales, DEFAULT_LOCALE };
