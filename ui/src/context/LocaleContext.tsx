import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTranslator, localeOptionLabels, matchSupportedLocale } from "../../../packages/shared/src/i18n.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "../../../packages/shared/src/constants.js";
import { authApi } from "@/api/auth";
import { i18nApi } from "@/api/i18n";
import { userPreferencesApi } from "@/api/userPreferences";
import { queryKeys } from "@/lib/queryKeys";
import { setCurrentLocale } from "@/lib/locale-store";

const LOCALE_STORAGE_KEY = "paperclip.locale";

interface LocaleContextValue {
  locale: SupportedLocale;
  supportedLocales: SupportedLocale[];
  localeOptionLabels: Record<SupportedLocale, string>;
  t: ReturnType<typeof createTranslator>["t"];
  tx: ReturnType<typeof createTranslator>["tx"];
  setLocalePreference: (locale: SupportedLocale) => Promise<void>;
  isUpdatingLocale: boolean;
}

const defaultTranslator = createTranslator(DEFAULT_LOCALE);

const defaultLocaleContextValue: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  supportedLocales: [...SUPPORTED_LOCALES],
  localeOptionLabels,
  t: defaultTranslator.t,
  tx: defaultTranslator.tx,
  setLocalePreference: async () => {},
  isUpdatingLocale: false,
};

const LocaleContext = createContext<LocaleContextValue>(defaultLocaleContextValue);

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
  return useContext(LocaleContext);
}
