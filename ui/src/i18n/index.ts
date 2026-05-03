import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import koCommon from "./locales/ko/common.json";
import { syncKoreanRuntimeTranslation } from "./runtime-ko";

const resources = {
  en: { common: enCommon },
  ko: { common: koCommon },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "ko",
    supportedLngs: ["en", "ko"],
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["querystring"],
      lookupQuerystring: "lng",
      lookupLocalStorage: "paperclip-language",
      caches: ["localStorage"],
    },
    returnNull: false,
  })
  .then(() => {
    syncKoreanRuntimeTranslation(i18n.language);
    i18n.on("languageChanged", syncKoreanRuntimeTranslation);
  });

export default i18n;
