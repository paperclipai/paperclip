import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

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

// Keep scaffold catalogs registered for parity checks, but expose only locales
// that have completed a native review. Add a locale here when its catalog is ready.
export const supportedLocales = [DEFAULT_LOCALE, "ru"];

function expandPluralFallbacks(locale: string, messages: unknown): unknown {
  const pluralCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;

  function visit(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;

    const expanded = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    ) as Record<string, unknown>;

    for (const [key, translation] of Object.entries(expanded)) {
      if (!key.endsWith("_other") || typeof translation !== "string") continue;
      const baseKey = key.slice(0, -"_other".length);
      for (const category of pluralCategories) {
        const pluralKey = `${baseKey}_${category}`;
        if (!(pluralKey in expanded)) expanded[pluralKey] = translation;
      }
    }

    return expanded;
  }

  return visit(messages);
}

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [
    locale,
    { translation: expandPluralFallbacks(locale, messages) },
  ]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
