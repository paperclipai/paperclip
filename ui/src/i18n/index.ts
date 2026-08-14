import i18n, { type InitOptions, type TOptions } from "i18next";
import { Trans, initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, LOCALE_STORAGE_KEY, resolveInitialLocale, supportedLocales, type SupportedLocale } from "./locales";

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

// First paint may have the static lang attr; sync it with the resolved locale
// (localStorage preference or VITE_DEFAULT_LOCALE) once the app boots.
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("lang", resolveInitialLocale());
}

/** Persist the user's locale preference and switch the active language.
 *  Returns whether the preference was persisted; when storage is unavailable
 *  the switch still applies for the session, and callers that need a reload
 *  (to re-evaluate module-level t() caches) should only reload when true. */
export function setLocale(locale: string): boolean {
  let persisted = false;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    persisted = true;
  } catch {
    // Storage may be unavailable (private mode); switching still applies for
    // the session.
  }
  // Keep <html lang> in sync for screen readers and browser translation hints.
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", locale);
  }
  void i18n.changeLanguage(locale);
  return persisted;
}

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation = useReactI18nextTranslation;
export { Trans, i18n };
