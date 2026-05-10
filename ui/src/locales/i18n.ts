import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const LANGUAGE_KEY = "paperclip_language";
const SUPPORTED_LANGUAGES = ["en"] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

function getInitialLanguage(): SupportedLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) {
      return saved as SupportedLanguage;
    }
  } catch {
    // ignore
  }
  return "en";
}

// Minimal resources for Stage 1 Infrastructure
const resources = {
  en: {
    common: {},
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: ["en"],
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  interpolation: {
    escapeValue: false,
  },
  react: { useSuspense: false },
});

export { LANGUAGE_KEY, SUPPORTED_LANGUAGES };
export type { SupportedLanguage };
export default i18n;
