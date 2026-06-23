import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { applyDocumentLanguage, persistLanguage, resolveInitialLanguage } from "./language";

const initialLanguage = resolveInitialLanguage();

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLanguage,
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

// Keep `<html lang>`/`<html dir>` in sync with the active locale, both on boot
// and whenever the user switches languages.
applyDocumentLanguage(initialLanguage);
i18n.on("languageChanged", (language: string) => {
  applyDocumentLanguage(language);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/**
 * Switch the active interface language and remember the choice. Components
 * using {@link useTranslation} re-render automatically via react-i18next.
 */
export async function setLanguage(locale: string): Promise<void> {
  persistLanguage(locale);
  await i18n.changeLanguage(locale);
}

export function getCurrentLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
