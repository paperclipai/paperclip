import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export const UI_LOCALE_STORAGE_KEY = "paperclip.ui.locale";
export const operatorLocales = ["en", "zh-CN"] as const;

export type OperatorLocale = (typeof operatorLocales)[number];

export const operatorLocaleNames: Record<OperatorLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

function isOperatorLocale(locale: string | null | undefined): locale is OperatorLocale {
  return operatorLocales.includes(locale as OperatorLocale);
}

function readStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLocale(locale: OperatorLocale): void {
  try {
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // A browser can deny storage in private or embedded contexts. The selected
    // language still applies for the active session.
  }
}

function applyDocumentLocale(locale: OperatorLocale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function matchOperatorLocale(locale: string | null | undefined): OperatorLocale | null {
  if (!locale) return null;

  const normalized = locale.toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return null;
}

function resolveInitialLocale(): OperatorLocale {
  if (typeof window !== "undefined") {
    const savedLocale = readStoredLocale();
    if (isOperatorLocale(savedLocale)) return savedLocale;
  }

  if (typeof navigator !== "undefined") {
    for (const locale of [navigator.language, ...(navigator.languages ?? [])]) {
      const match = matchOperatorLocale(locale);
      if (match) return match;
    }
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

applyDocumentLocale(initialLocale);
i18n.on("languageChanged", (locale) => {
  applyDocumentLocale(isOperatorLocale(locale) ? locale : DEFAULT_LOCALE);
});

export async function setOperatorLocale(locale: OperatorLocale): Promise<void> {
  if (typeof window !== "undefined") {
    storeLocale(locale);
  }
  await i18n.changeLanguage(locale);
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
