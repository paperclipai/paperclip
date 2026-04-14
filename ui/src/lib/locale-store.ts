import { DEFAULT_LOCALE, type SupportedLocale } from "../../../packages/shared/src/constants.js";

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

export function getCurrentLocale() {
  return currentLocale;
}

export function setCurrentLocale(locale: SupportedLocale) {
  currentLocale = locale;
}
