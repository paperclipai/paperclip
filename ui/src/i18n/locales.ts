import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

export const DEFAULT_LOCALE = "en" as const;
export const supportedLocales = [DEFAULT_LOCALE, "ru"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

// Register only catalogs with reviewed, complete message coverage. The
// repository still contains small locale scaffolds for future contributors,
// but exposing those files would present an almost entirely English UI as a
// translated language.
export const localeMessages = { en, ru } as const;

for (const [locale, messages] of Object.entries(localeMessages)) {
  try {
    assertValidLocaleMessages(messages, en, locale);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
}

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (supportedLocales as readonly string[]).includes(locale);
}

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
