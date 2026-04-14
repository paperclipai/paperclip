import { DEFAULT_LOCALE, type SupportedLocale } from "@paperclipai/shared";

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

export function getCurrentLocale() {
  return currentLocale;
}

export function setCurrentLocale(locale: SupportedLocale) {
  currentLocale = locale;
}
