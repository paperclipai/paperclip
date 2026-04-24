import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  type AppLocale,
  type TranslationParams,
  getActiveLocale,
  resolveLocale,
  tForLocale,
} from "@/lib/i18n";

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: string, params?: TranslationParams) => string;
  localeLabel: string;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function applyLocale(locale: AppLocale) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = locale;
  root.setAttribute("data-locale", locale);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(() => getActiveLocale());

  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(resolveLocale(nextLocale));
  }, []);

  useEffect(() => {
    applyLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore restricted storage environments.
    }
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => tForLocale(locale, key, params),
      localeLabel: LOCALE_LABELS[locale] ?? LOCALE_LABELS[DEFAULT_LOCALE],
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useI18n must be used within LocaleProvider");
  }
  return context;
}
