export const UI_LOCALE_STORAGE_KEY = "paperclip.ui.locale";

export const SUPPORTED_UI_LOCALES = ["en", "zh"] as const;
export type UILocale = (typeof SUPPORTED_UI_LOCALES)[number];

export function isUILocale(value: string | undefined | null): value is UILocale {
  return value === "en" || value === "zh";
}

export function resolveInitialUILocale(): UILocale {
  const fromEnv = import.meta.env.VITE_UI_LOCALE?.trim();
  if (isUILocale(fromEnv)) return fromEnv;

  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
      if (isUILocale(stored)) return stored;
    } catch {
      // ignore storage failures (SSR / privacy mode)
    }
  }

  return "zh";
}

export function persistUILocale(locale: UILocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export function setUILocale(locale: UILocale, i18n: { changeLanguage: (lng: string) => Promise<unknown> }): Promise<unknown> {
  persistUILocale(locale);
  return i18n.changeLanguage(locale);
}
