import type { Resource } from "i18next";

import { assertValidLocaleMessages, validateLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;
// Locales that we hand-translate and validate strictly against en.json.
// en and tr maintain full parity; missing keys here fail the build/runtime
// validation so translation gaps are caught early.
const STRICT_LOCALES = new Set(["en", "tr"]);

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

// Strict validation only for hand-maintained locales (en, tr). Other locales
// can be incomplete — i18next will fall back to en for missing keys.
for (const [locale, messages] of Object.entries(localeMessages)) {
  if (STRICT_LOCALES.has(locale)) {
    try {
      assertValidLocaleMessages(messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ${locale} locale messages: ${message}`);
    }
  } else {
    // Non-strict: surface any structural issues to the console but never throw.
    const issues = validateLocaleMessages(messages);
    if (issues.length > 0 && typeof console !== "undefined") {
      console.warn(`[i18n] ${locale} has ${issues.length} non-blocking validation issue(s); falling back to ${DEFAULT_LOCALE} where needed.`);
    }
  }
}

export const supportedLocales = Object.keys(localeMessages);

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
