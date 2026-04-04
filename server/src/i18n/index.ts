import i18next, { type TFunction } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };

export const supportedLanguages = ["en", "es"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export async function initI18n() {
  await i18next.init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: supportedLanguages,
    interpolation: {
      escapeValue: false,
    },
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
  });

  return i18next;
}

/**
 * Get a translation function for a specific language.
 * Falls back to 'en' if the language is not supported.
 */
export function getFixedT(language: string): TFunction {
  return i18next.getFixedT(language);
}

export { i18next };
