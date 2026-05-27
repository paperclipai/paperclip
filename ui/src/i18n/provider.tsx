import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { i18n } from "./index";
import { DEFAULT_LOCALE, supportedLocales, type SupportedLocale } from "./locales";

const LOCALE_STORAGE_KEY = "paperclip.ui.locale";
const supportedLocaleSet = new Set<string>(supportedLocales);

function isSupportedLocale(locale: string) {
  return supportedLocaleSet.has(locale);
}

function normalizeLocale(locale: string | null | undefined): SupportedLocale | null {
  if (!locale) return null;
  if (isSupportedLocale(locale)) return locale as SupportedLocale;

  const normalized = locale.trim().toLowerCase();
  const exact = supportedLocales.find((candidate) => candidate.toLowerCase() === normalized);
  if (exact) return exact as SupportedLocale;

  if (normalized === "pt" || normalized.startsWith("pt-")) {
    return isSupportedLocale("pt-BR") ? "pt-BR" as SupportedLocale : null;
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return isSupportedLocale("en") ? "en" as SupportedLocale : null;
  }

  return null;
}

function detectPreferredLocale(): SupportedLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    const storedLocale = normalizeLocale(stored);
    if (storedLocale) return storedLocale;
  } catch {
    // Ignore storage failures.
  }

  const preferredLocales = [
    ...(navigator.languages ?? []),
    navigator.language,
  ];
  for (const preferredLocale of preferredLocales) {
    const normalized = normalizeLocale(preferredLocale);
    if (normalized) return normalized;
  }

  return DEFAULT_LOCALE;
}

type I18nContextValue = {
  locale: SupportedLocale;
  supportedLocales: SupportedLocale[];
  setLocale: (locale: SupportedLocale) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(detectPreferredLocale);

  useEffect(() => {
    void i18n.changeLanguage(locale).catch((error: unknown) => {
      console.error("Failed to change locale", error);
    });

    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }

    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        // Ignore storage failures.
      }
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      supportedLocales: supportedLocales as SupportedLocale[],
      setLocale: (nextLocale: SupportedLocale) => setLocaleState(nextLocale),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useLocale must be used inside I18nProvider");
  }
  return context;
}
