import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { en, type TranslationKey } from "./en";
import { ko } from "./ko";

type Locale = "en" | "ko";
const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, ko };

interface I18nContextValue {
  locale: Locale;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  t: (key) => en[key],
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    staleTime: 60_000,
  });
  const locale: Locale = (data?.locale as Locale) ?? "en";
  const dict = dictionaries[locale] ?? en;
  const t = useMemo(() => (key: TranslationKey) => dict[key] ?? en[key] ?? key, [dict]);
  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext);
}

export type { TranslationKey, Locale };
