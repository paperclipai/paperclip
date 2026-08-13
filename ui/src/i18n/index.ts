import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

function matchSupportedLocale(candidate: string): string | null {
  const normalized = candidate.replace("_", "-").toLowerCase();
  const exact = supportedLocales.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;

  if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-sg")) {
    return supportedLocales.includes("zh-CN") ? "zh-CN" : null;
  }
  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk") || normalized.startsWith("zh-mo")) {
    return supportedLocales.includes("zh-TW") ? "zh-TW" : null;
  }

  const base = normalized.split("-")[0];
  return supportedLocales.find((locale) => locale.toLowerCase() === base) ?? null;
}

export function applyDocumentLocale(locale: string) {
  if (typeof document === "undefined") return;
  const resolved = matchSupportedLocale(locale) ?? DEFAULT_LOCALE;
  document.documentElement.lang = resolved;
  document.documentElement.dir = RTL_LANGUAGES.has(resolved.split("-")[0].toLowerCase()) ? "rtl" : "ltr";
}

function resolveInitialLocale(): string {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const persisted = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (persisted) {
      const match = matchSupportedLocale(persisted);
      if (match) return match;
    }
    for (const candidate of window.navigator?.languages ?? [window.navigator?.language]) {
      if (!candidate) continue;
      const match = matchSupportedLocale(candidate);
      if (match) return match;
    }
  } catch {
    // localStorage/navigator unavailable (e.g. hardened privacy settings).
  }
  return DEFAULT_LOCALE;
}

const initialLocale = resolveInitialLocale();

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
applyDocumentLocale(initialLocale);
i18n.on("languageChanged", applyDocumentLocale);

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function setLocale(locale: string) {
  if (!supportedLocales.includes(locale)) return;
  void i18n.changeLanguage(locale);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures.
  }
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, supportedLocales };
