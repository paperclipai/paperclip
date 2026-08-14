import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

export const LOCALE_STORAGE_KEY = "paperclip.locale";

/** Resolve the user's preferred locale from localStorage, falling back to the
 *  server-provided default (`VITE_DEFAULT_LOCALE`) and finally the app default.
 *  The user's explicit choice persists across sessions and takes precedence so
 *  e.g. zh-CN users keep their preference after upgrade. */
export function resolveInitialLocale(): string {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && stored in localeMessages) {
      return stored;
    }
  }
  const envDefault = import.meta.env.VITE_DEFAULT_LOCALE;
  if (typeof envDefault === "string" && envDefault && envDefault in localeMessages) {
    return envDefault;
  }
  return DEFAULT_LOCALE;
}

const localeModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export const localeMessages = Object.fromEntries(
  Object.entries(localeModules).map(([path, messages]) => {
    const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
    if (!locale) {
      throw new Error(`Invalid locale file path: ${path}`);
    }
    return [locale, messages];
  }),
);

if (!(DEFAULT_LOCALE in localeMessages)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

for (const [locale, messages] of Object.entries(localeMessages)) {
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
}

export const supportedLocales = Object.keys(localeMessages);

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
