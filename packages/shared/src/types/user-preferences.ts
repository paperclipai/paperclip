import type { SupportedLocale } from "../constants.js";

export interface UserPreferences {
  locale: SupportedLocale | null;
}

export interface I18nConfig {
  defaultLocale: SupportedLocale;
  supportedLocales: SupportedLocale[];
}
