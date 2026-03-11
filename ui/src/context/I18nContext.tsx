import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "ko";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
}

const LOCALE_STORAGE_KEY = "paperclip.locale";

const messages: Record<Locale, Record<string, string>> = {
  en: {
    "layout.skipToMain": "Skip to Main Content",
    "layout.documentation": "Documentation",
    "layout.switchTheme": "Switch to {theme} mode",
    "layout.switchLanguage": "Switch to Korean",
    "theme.light": "light",
    "theme.dark": "dark",

    "sidebar.selectCompany": "Select company",
    "sidebar.newIssue": "New Issue",
    "sidebar.dashboard": "Dashboard",
    "sidebar.inbox": "Inbox",
    "sidebar.work": "Work",
    "sidebar.issues": "Issues",
    "sidebar.goals": "Goals",
    "sidebar.company": "Company",
    "sidebar.org": "Org",
    "sidebar.costs": "Costs",
    "sidebar.activity": "Activity",
    "sidebar.settings": "Settings",
  },
  ko: {
    "layout.skipToMain": "메인 콘텐츠로 건너뛰기",
    "layout.documentation": "문서",
    "layout.switchTheme": "{theme} 모드로 전환",
    "layout.switchLanguage": "영어로 전환",
    "theme.light": "라이트",
    "theme.dark": "다크",

    "sidebar.selectCompany": "회사 선택",
    "sidebar.newIssue": "새 이슈",
    "sidebar.dashboard": "대시보드",
    "sidebar.inbox": "받은함",
    "sidebar.work": "작업",
    "sidebar.issues": "이슈",
    "sidebar.goals": "목표",
    "sidebar.company": "회사",
    "sidebar.org": "조직",
    "sidebar.costs": "비용",
    "sidebar.activity": "활동",
    "sidebar.settings": "설정",
  },
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "ko";
}

function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Ignore local storage read failures in restricted environments.
  }

  const browserLocale = navigator.language.toLowerCase();
  if (browserLocale.startsWith("ko")) return "ko";
  return "en";
}

function formatMessage(locale: Locale, key: string, vars?: Record<string, string>): string {
  let value = messages[locale][key] ?? messages.en[key] ?? key;
  if (!vars) return value;
  for (const [varKey, varValue] of Object.entries(vars)) {
    value = value.replaceAll(`{${varKey}}`, varValue);
  }
  return value;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale());

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((current) => (current === "en" ? "ko" : "en"));
  }, []);

  const t = useCallback(
    (key: string) => {
      return formatMessage(locale, key);
    },
    [locale],
  );

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [locale]);

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      toggleLocale,
      t,
    }),
    [locale, setLocale, toggleLocale, t],
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

export function tWithVars(locale: Locale, key: string, vars: Record<string, string>) {
  return formatMessage(locale, key, vars);
}
