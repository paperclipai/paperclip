import type { Resource } from "i18next";

export const DEFAULT_LOCALE = "ru" as const;

const localeModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export const localeMessages = Object.fromEntries(
  Object.entries(localeModules).map(([path, messages]) => {
    const m = path.match(/\/([A-Za-z0-9_-]+)\.json$/);
    if (!m) {
      throw new Error("Invalid locale file path: " + path);
    }
    return [m[1], messages];
  }),
);

if (!(DEFAULT_LOCALE in localeMessages)) {
  throw new Error("Missing default locale messages for " + DEFAULT_LOCALE);
}

export const supportedLocales = Object.keys(localeMessages);

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
