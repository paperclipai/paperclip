import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import {
  DEFAULT_LOCALE,
  i18nextResources,
  loadLocaleMessages,
  supportedLocales,
} from "./locales";

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: DEFAULT_LOCALE,
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

/**
 * Switch the active locale, lazily loading and registering its messages first.
 * The default locale ships in the initial bundle; every other locale's messages
 * are code-split and fetched on first activation, then cached in i18next.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!supportedLocales.includes(locale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  if (locale !== DEFAULT_LOCALE && !i18n.hasResourceBundle(locale, "translation")) {
    const messages = await loadLocaleMessages(locale);
    i18n.addResourceBundle(locale, "translation", messages, true, true);
  }
  await i18n.changeLanguage(locale);
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
