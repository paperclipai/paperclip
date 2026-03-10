import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import enUS from "@/locales/en-US.json";
import jaJP from "@/locales/ja-JP.json";
import koKR from "@/locales/ko-KR.json";
import zhCN from "@/locales/zh-CN.json";
import zhHK from "@/locales/zh-HK.json";
 
function normalizeDetectedLanguage(lng: string) {
  const lower = lng.toLowerCase();
  if (lower.startsWith("zh")) {
    if (lower.startsWith("zh-hk") || lower.startsWith("zh-tw")) return "zh-HK";
    return "zh-CN";
  }
  if (lower.startsWith("ja")) return "ja-JP";
  if (lower.startsWith("ko")) return "ko-KR";
  if (lower.startsWith("en")) return "en-US";
  return "en-US";
}
 
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "en-US": { translation: enUS },
      "zh-CN": { translation: zhCN },
      "zh-HK": { translation: zhHK },
      "ja-JP": { translation: jaJP },
      "ko-KR": { translation: koKR },
    },
    supportedLngs: ["en", "en-US", "zh", "zh-CN", "zh-HK", "ja", "ja-JP", "ko", "ko-KR"],
    fallbackLng: {
      zh: ["zh-CN"],
      ja: ["ja-JP"],
      ko: ["ko-KR"],
      default: ["en-US"],
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      convertDetectedLanguage: normalizeDetectedLanguage,
    },
    debug: import.meta.env.DEV,
    interpolation: {
      escapeValue: false,
    },
  });
 
export default i18n;
