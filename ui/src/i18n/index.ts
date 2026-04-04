import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enAgents from "./locales/en/agents.json";
import esCommon from "./locales/es/common.json";
import esAgents from "./locales/es/agents.json";

export const supportedLanguages = {
  en: "English",
  es: "Español (Latinoamérica)",
} as const;

export type SupportedLanguage = keyof typeof supportedLanguages;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, agents: enAgents },
      es: { common: esCommon, agents: esAgents },
    },
    defaultNS: "common",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "paperclip-lang",
    },
  });

/** Returns the BCP 47 locale tag for Intl APIs based on the current i18n language. */
export function getIntlLocale(): string {
  const lng = i18n.language;
  if (lng === "es") return "es-419";
  return "en-US";
}

export default i18n;
