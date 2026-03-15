import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { enCommonMessages } from "./locales/en/common";
import { zhCnCommonMessages } from "./locales/zh-CN/common";
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type TranslationMessages,
  type TranslationParams,
} from "./types";

const LOCALE_STORAGE_KEY = "paperclip.locale";
const DEFAULT_LOCALE: SupportedLocale = "en";
const INTL_LOCALES: Record<SupportedLocale, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
};

const messagesByLocale: Record<SupportedLocale, TranslationMessages> = {
  en: enCommonMessages,
  "zh-CN": zhCnCommonMessages,
};

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: string) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: readonly SupportedLocale[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function normalizeLocale(input: string | null | undefined): SupportedLocale {
  if (!input) return DEFAULT_LOCALE;
  const normalized = input.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized.startsWith("zh")) return "zh-CN";
  return "en";
}

export function resolvePreferredLocale(options?: {
  storedLocale?: string | null;
  browserLanguage?: string | null;
}): SupportedLocale {
  if (options?.storedLocale) return normalizeLocale(options.storedLocale);
  if (options?.browserLanguage) return normalizeLocale(options.browserLanguage);
  return DEFAULT_LOCALE;
}

export function formatTranslation(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function translate(locale: SupportedLocale, key: string, params?: TranslationParams): string {
  const template = messagesByLocale[locale][key] ?? messagesByLocale[DEFAULT_LOCALE][key] ?? key;
  return formatTranslation(template, params);
}

export function getCurrentLocale(): SupportedLocale {
  return currentLocale;
}

export function getCurrentIntlLocale(): string {
  return INTL_LOCALES[currentLocale] ?? INTL_LOCALES[DEFAULT_LOCALE];
}

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: SupportedLocale }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    if (initialLocale) return initialLocale;
    const browserLanguage = typeof navigator === "undefined" ? null : navigator.language;
    return resolvePreferredLocale({ storedLocale: readStoredLocale(), browserLanguage });
  });

  const setLocale = useCallback((nextLocale: string) => {
    setLocaleState(normalizeLocale(nextLocale));
  }, []);

  useEffect(() => {
    currentLocale = locale;
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage write failures in restricted environments.
    }
  }, [locale]);

  const t = useCallback((key: string, params?: TranslationParams) => translate(locale, key, params), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
