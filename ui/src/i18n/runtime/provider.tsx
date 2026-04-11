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
  getCurrentLocale,
  setCurrentLocale,
  supportedLocales,
  normalizeLocale,
  translate,
  type MessageKey,
  type SupportedLocale,
  type TranslationValues,
} from "./adapter";

export const I18N_LOCALE_STORAGE_KEY = "paperclip.locale";

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  supportedLocales: readonly SupportedLocale[];
  t: (key: MessageKey, fallback?: string, values?: TranslationValues) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function resolveLocaleFromEnvironment(): SupportedLocale {
  try {
    const storedLocale = localStorage.getItem(I18N_LOCALE_STORAGE_KEY);
    if (storedLocale) return normalizeLocale(storedLocale);
  } catch {
    // Ignore local storage read failures in restricted environments.
  }

  if (typeof navigator !== "undefined") {
    return normalizeLocale(navigator.languages?.[0] ?? navigator.language);
  }

  return getCurrentLocale();
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const resolvedLocale = resolveLocaleFromEnvironment();
    setCurrentLocale(resolvedLocale);
    return resolvedLocale;
  });

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    const normalizedLocale = setCurrentLocale(nextLocale);
    setLocaleState(normalizedLocale);
  }, []);

  useEffect(() => {
    setCurrentLocale(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    try {
      localStorage.setItem(I18N_LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, fallback?: string, values?: TranslationValues) => translate(key, { locale, fallback, values }),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      supportedLocales,
      t,
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
