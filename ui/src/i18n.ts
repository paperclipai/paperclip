import { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";
import { createElement, type ReactNode } from "react";

import enCommon from "./locales/en/common.json";
import ptCommon from "./locales/pt/common.json";

const resources: Record<string, Record<string, unknown>> = {
  en: enCommon,
  pt: ptCommon,
};

function getNestedValue(obj: unknown, path: string): string {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return path;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : path;
}

function detectLanguage(): string {
  const stored = localStorage.getItem("i18nextLng");
  if (stored) return stored.startsWith("pt") ? "pt" : "en";
  const nav = navigator.language;
  return nav.startsWith("pt") ? "pt" : "en";
}

interface I18nInstance {
  language: string;
  changeLanguage: (lang: string) => void;
}

interface I18nContextValue {
  t: (key: string) => string;
  i18n: I18nInstance;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(detectLanguage);

  const changeLanguage = useCallback((lang: string) => {
    const resolved = lang.startsWith("pt") ? "pt" : "en";
    setLanguage(resolved);
    localStorage.setItem("i18nextLng", resolved);
  }, []);

  const t = useCallback(
    (key: string): string => {
      const dict = resources[language] ?? resources.en;
      return getNestedValue(dict, key);
    },
    [language],
  );

  const i18n = useMemo<I18nInstance>(
    () => ({ language, changeLanguage }),
    [language, changeLanguage],
  );

  const value = useMemo(() => ({ t, i18n }), [t, i18n]);

  return createElement(I18nContext.Provider, { value }, children);
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useTranslation must be used within I18nProvider");
  }
  return ctx;
}
