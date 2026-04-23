import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { enMessages } from "../i18n/messages/en";
import { zhCnMessages } from "../i18n/messages/zh-CN";
import { translate } from "../i18n/translate";
import type { TranslateParams, UiLocale } from "../i18n/types";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "./CompanyContext";

type I18nContextValue = {
  locale: UiLocale;
  t: (key: string, params?: TranslateParams) => string;
};

const catalogs = {
  en: enMessages,
  "zh-CN": zhCnMessages,
} as const;

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { selectedCompany } = useCompany();
  const { data: instanceGeneral } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const locale: UiLocale = selectedCompany?.localeOverride ?? instanceGeneral?.locale ?? "en";

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t: (key, params) => translate(key, locale, catalogs, params),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
