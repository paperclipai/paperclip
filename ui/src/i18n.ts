import i18n from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";

export interface Language {
  code: string;
  label: string;
  flag: string;
}

const _supportedLanguages: Language[] = [
  { code: "en", label: "English", flag: "🇺🇸" },
];

const listeners = new Set<() => void>();

export const getSupportedLanguages = () => [..._supportedLanguages];

export const subscribeToLanguages = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    lng: "en",
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "paperclip-language",
      caches: ["localStorage"],
    },
    react: {
      useSuspense: false,
    },
  });

/**
 * Helper to allow plugins to register additional language packs.
 */
export const registerLanguage = (lang: Language, translations: Record<string, any>) => {
  if (!_supportedLanguages.find((l) => l.code === lang.code)) {
    _supportedLanguages.push(lang);
    i18n.addResourceBundle(lang.code, "translation", translations, true, true);
    console.log(`[i18n] Registered language pack: ${lang.label} (${lang.code})`);
    listeners.forEach((l) => l());
  }
};

export const useTranslation = useReactI18nextTranslation;
export { i18n };
export default i18n;
