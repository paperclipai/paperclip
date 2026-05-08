import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import i18n from "./index";

const SUPPORTED_LOCALES = ["en", "zh"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_STORAGE_KEY = "paperclip.locale";
const DEFAULT_LOCALE: SupportedLocale = "en";

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  supportedLocales: readonly SupportedLocale[];
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function resolveInitialLocale(): SupportedLocale {
  if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
    return stored as SupportedLocale;
  }
  const browserLang = typeof navigator !== "undefined" ? navigator.language : undefined;
  if (browserLang) {
    const matched = SUPPORTED_LOCALES.find((locale) =>
      browserLang === locale || browserLang.startsWith(`${locale}-`),
    );
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(resolveInitialLocale);

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    i18n.changeLanguage(locale).catch(() => {
      // Ignore errors from language change
    });
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore local storage write failures in restricted environments
    }
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }
  return context;
}
