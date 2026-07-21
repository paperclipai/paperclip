import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  i18nextResources,
  supportedLocales,
  type SupportedLocale,
} from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

export const appLocales: Array<{ value: SupportedLocale; label: string; shortLabel: string }> = [
  { value: "en", label: "English", shortLabel: "EN" },
  { value: "zh-CN", label: "简体中文", shortLabel: "中" },
];

function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return value === "en" || value === "zh-CN";
}

function resolveInitialLocale(): SupportedLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {
    // Storage can be unavailable in private browsing or hardened webviews.
  }

  const browserLanguages = window.navigator.languages?.length
    ? window.navigator.languages
    : [window.navigator.language];
  return browserLanguages.some((language) => language?.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : DEFAULT_LOCALE;
}

function syncDocumentLocale(locale: SupportedLocale) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Keep the in-memory locale even when persistence is unavailable.
    }
  }
}

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: resolveInitialLocale(),
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

syncDocumentLocale(i18n.language as SupportedLocale);
i18n.on("languageChanged", (locale) => {
  if (isSupportedLocale(locale)) syncDocumentLocale(locale);
});

export async function setLocale(locale: SupportedLocale) {
  if (!isSupportedLocale(locale)) return;
  await i18n.changeLanguage(locale);
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
