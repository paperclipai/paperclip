import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export { DEFAULT_LOCALE, supportedLocales };

// --- Locale detection & persistence ---
const LOCALE_STORAGE_KEY = "paperclip:locale";

/**
 * Native display names for the language switcher.
 * Keep in sync with the files present in ./locales.
 */
export const LOCALE_NATIVE_NAMES: Record<string, string> = {
  en: "English",
  "zh-CN": "中文（简体）",
  "zh-TW": "中文（繁體）",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ru: "Русский",
  uk: "Українська",
  ar: "العربية",
  he: "עברית",
  hi: "हिन्दी",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  sv: "Svenska",
  nb: "Norsk Bokmål",
  fi: "Suomi",
  da: "Dansk",
  cs: "Čeština",
  el: "Ελληνικά",
  hu: "Magyar",
  ro: "Română",
  th: "ไทย",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  ms: "Bahasa Melayu",
  fa: "فارسی",
  ur: "اردو",
  bn: "বাংলা",
  ta: "தமிழ்",
  te: "తెలుగు",
  mr: "मराठी",
  pa: "ਪੰਜਾਬੀ",
  sw: "Kiswahili",
  fil: "Filipino",
};

function readStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: string): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

/**
 * Resolve the best supported locale for a raw BCP-47 tag (e.g. "zh-CN", "zh", "en-US").
 * Returns the supported locale code, or null if nothing matches.
 */
export function matchSupportedLocale(rawLanguage: string): string | null {
  if (!rawLanguage) return null;
  const lower = rawLanguage.toLowerCase();
  // Exact match (case-insensitive) e.g. "zh-CN" -> "zh-CN"
  const exact = supportedLocales.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  // Primary subtag match e.g. "zh-Hans-CN" -> "zh", "en-US" -> "en"
  const primary = lower.split("-")[0];
  const byPrimary = supportedLocales.find((code) => code.toLowerCase().split("-")[0] === primary);
  if (byPrimary) return byPrimary;
  // Special: any "zh" variant not yet matched prefers Simplified
  if (primary === "zh") return supportedLocales.includes("zh-CN") ? "zh-CN" : null;
  return null;
}

function detectInitialLocale(): string {
  // 1. User's explicit persisted choice wins
  const stored = readStoredLocale();
  if (stored && supportedLocales.includes(stored)) return stored;
  // 2. Browser language(s)
  if (typeof navigator !== "undefined") {
    const candidates = [navigator.language, ...(navigator.languages ?? [])];
    for (const candidate of candidates) {
      const matched = matchSupportedLocale(candidate);
      if (matched) return matched;
    }
  }
  // 3. Fall back to English
  return DEFAULT_LOCALE;
}

const initialLocale = detectInitialLocale();

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLocale,
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

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/**
 * Switch the active UI language at runtime.
 * Persists the choice so it survives reloads.
 * Returns the locale that was actually applied.
 */
export function setLocale(locale: string): string {
  const target = supportedLocales.includes(locale) ? locale : DEFAULT_LOCALE;
  writeStoredLocale(target);
  void i18n.changeLanguage(target);
  return target;
}

/** Current active locale code (reactive — re-render via useTranslation). */
export function getLocale(): string {
  return i18n.language || DEFAULT_LOCALE;
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
