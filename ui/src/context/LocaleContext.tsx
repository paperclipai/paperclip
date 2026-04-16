import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTranslator, localeOptionLabels, matchSupportedLocale } from "@paperclipai/shared/i18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { i18nApi } from "@/api/i18n";
import { userPreferencesApi } from "@/api/userPreferences";
import { queryKeys } from "@/lib/queryKeys";
import { getCurrentLocale, setCurrentLocale } from "@/lib/locale-store";

const LOCALE_STORAGE_KEY = "paperclip.locale";
const fallbackSupportedLocales = [...SUPPORTED_LOCALES];
const fallbackSetLocalePreference: LocaleContextValue["setLocalePreference"] = async () => {};

interface LocaleContextValue {
  locale: SupportedLocale;
  supportedLocales: SupportedLocale[];
  localeOptionLabels: Record<SupportedLocale, string>;
  t: ReturnType<typeof createTranslator>["t"];
  tx: ReturnType<typeof createTranslator>["tx"];
  setLocalePreference: (locale: SupportedLocale) => Promise<void>;
  isUpdatingLocale: boolean;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readStoredLocale() {
  if (typeof window === "undefined") return null;
  try {
    return matchSupportedLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function readBrowserLocale() {
  if (typeof navigator === "undefined") return null;
  return matchSupportedLocale(navigator.languages?.[0] ?? navigator.language);
}

function persistLocale(locale: SupportedLocale) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [localLocale, setLocalLocale] = useState<SupportedLocale | null>(() => readStoredLocale());

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const configQuery = useQuery({
    queryKey: queryKeys.i18n.config,
    queryFn: () => i18nApi.getConfig(),
    retry: false,
  });

  const canPersistUserPreference =
    Boolean(sessionQuery.data) && sessionQuery.data?.user.source !== "local_implicit";

  const userPreferencesQuery = useQuery({
    queryKey: queryKeys.userPreferences.current,
    queryFn: () => userPreferencesApi.getCurrent(),
    enabled: canPersistUserPreference,
    retry: false,
  });

  const updatePreferenceMutation = useMutation({
    mutationFn: (locale: SupportedLocale) => userPreferencesApi.updateCurrent({ locale }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.userPreferences.current });
    },
  });

  const supportedLocales = configQuery.data?.supportedLocales ?? [...SUPPORTED_LOCALES];
  const locale =
    localLocale ??
    userPreferencesQuery.data?.locale ??
    configQuery.data?.defaultLocale ??
    readBrowserLocale() ??
    DEFAULT_LOCALE;

  useEffect(() => {
    setCurrentLocale(locale);
  }, [locale]);

  const translator = useMemo(() => createTranslator(locale), [locale]);

  const setLocalePreference = useCallback(
    async (nextLocale: SupportedLocale) => {
      setLocalLocale(nextLocale);
      persistLocale(nextLocale);
      setCurrentLocale(nextLocale);

      if (!canPersistUserPreference) return;
      await updatePreferenceMutation.mutateAsync(nextLocale);
    },
    [canPersistUserPreference, updatePreferenceMutation],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      supportedLocales,
      localeOptionLabels,
      t: translator.t,
      tx: translator.tx,
      setLocalePreference,
      isUpdatingLocale: updatePreferenceMutation.isPending,
    }),
    [locale, setLocalePreference, supportedLocales, translator, updatePreferenceMutation.isPending],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within a LocaleProvider");
  }
  return context;
}

export function useLocaleOrFallback(): LocaleContextValue {
  const context = useContext(LocaleContext);
  const locale = context?.locale ?? getCurrentLocale();
  const translator = useMemo(() => createTranslator(locale), [locale]);

  return context ?? {
    locale,
    supportedLocales: fallbackSupportedLocales,
    localeOptionLabels,
    t: translator.t,
    tx: translator.tx,
    setLocalePreference: fallbackSetLocalePreference,
    isUpdatingLocale: false,
  };
}
