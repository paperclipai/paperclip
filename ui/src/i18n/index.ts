import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

function normalizeSupportedLocale(candidate: string | null | undefined) {
  if (!candidate) return null;
  const normalized = candidate.trim();
  if (!normalized) return null;

  if (supportedLocales.includes(normalized)) return normalized;

  const base = normalized.split("-")[0];
  if (base && supportedLocales.includes(base)) return base;

  return null;
}

function resolveInitialLocale() {
  const envLocale = normalizeSupportedLocale(import.meta.env?.VITE_PAPERCLIP_LOCALE);
  if (envLocale) return envLocale;

  if (typeof window !== "undefined") {
    try {
      const storedLocale = normalizeSupportedLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
      if (storedLocale) return storedLocale;
    } catch {
      // Ignore storage access errors and fall through to browser language.
    }

    const browserLocales = [
      ...(Array.isArray(window.navigator.languages) ? window.navigator.languages : []),
      window.navigator.language,
    ];
    for (const locale of browserLocales) {
      const supportedLocale = normalizeSupportedLocale(locale);
      if (supportedLocale) return supportedLocale;
    }
  }

  return DEFAULT_LOCALE;
}

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

export const useTranslation = useReactI18nextTranslation;
export { i18n };
