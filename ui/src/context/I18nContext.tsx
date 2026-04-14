import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  LOCALE_STORAGE_KEY,
  detectInitialLocale,
  getLocaleToggleTarget,
  setActiveLocale,
  translate,
  formatDate as fmtDate,
  formatDateTime as fmtDateTime,
  formatShortDate as fmtShortDate,
  formatNumber as fmtNumber,
  formatCurrency as fmtCurrency,
  formatRelativeTime as fmtRelativeTime,
  type Locale,
  type MessageKey,
  type TranslationParams,
} from "../lib/i18n";
import { instanceSettingsApi } from "../api/instanceSettings";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: MessageKey | string, params?: TranslationParams) => string;
  formatDate: (date: Date | string) => string;
  formatDateTime: (date: Date | string) => string;
  formatShortDate: (date: Date | string) => string;
  formatNumber: (value: number) => string;
  formatCurrency: (cents: number, currency?: string) => string;
  formatRelativeTime: (date: Date | string) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initialLocale = detectInitialLocale();
    setActiveLocale(initialLocale);
    return initialLocale;
  });
  const isInitialMount = useRef(true);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((current) => getLocaleToggleTarget(current));
  }, []);

  useEffect(() => {
    setActiveLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures in restricted environments.
    }
    // Persist locale to instance settings so agents receive PAPERCLIP_UI_LOCALE.
    // Skip the first mount to avoid overwriting the server value on initial load.
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    instanceSettingsApi.updateGeneral({ locale }).catch(() => {
      // Best-effort — don't block the UI if the API call fails.
    });
  }, [locale]);

  const t = useCallback(
    (key: MessageKey | string, params?: TranslationParams) =>
      translate(locale, key, params),
    [locale],
  );

  const formatDate = useCallback(
    (date: Date | string) => fmtDate(locale, date),
    [locale],
  );

  const formatDateTime = useCallback(
    (date: Date | string) => fmtDateTime(locale, date),
    [locale],
  );

  const formatShortDate = useCallback(
    (date: Date | string) => fmtShortDate(locale, date),
    [locale],
  );

  const formatNumber = useCallback(
    (value: number) => fmtNumber(locale, value),
    [locale],
  );

  const formatCurrency = useCallback(
    (cents: number, currency?: string) => fmtCurrency(locale, cents, currency),
    [locale],
  );

  const formatRelativeTime = useCallback(
    (date: Date | string) => fmtRelativeTime(locale, date),
    [locale],
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      toggleLocale,
      t,
      formatDate,
      formatDateTime,
      formatShortDate,
      formatNumber,
      formatCurrency,
      formatRelativeTime,
    }),
    [
      locale,
      setLocale,
      toggleLocale,
      t,
      formatDate,
      formatDateTime,
      formatShortDate,
      formatNumber,
      formatCurrency,
      formatRelativeTime,
    ],
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
