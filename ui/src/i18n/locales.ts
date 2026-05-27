import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;
export const DEFAULT_NAMESPACE = "common" as const;

const localeModules = import.meta.glob("./locales/*/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

function parseLocalePath(path: string) {
  const match = path.match(/\/locales\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.json$/);
  if (!match) {
    throw new Error(`Invalid locale file path: ${path}`);
  }
  return { locale: match[1]!, namespace: match[2]! };
}

export const localeMessages: Record<string, Record<string, unknown>> = {};

for (const [path, messages] of Object.entries(localeModules)) {
  const { locale, namespace } = parseLocalePath(path);
  if (!localeMessages[locale]) localeMessages[locale] = {};
  localeMessages[locale][namespace] = messages;
}

if (!(DEFAULT_LOCALE in localeMessages)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

const defaultLocaleNamespaces = Object.keys(localeMessages[DEFAULT_LOCALE] ?? {});
if (!defaultLocaleNamespaces.includes(DEFAULT_NAMESPACE)) {
  throw new Error(`Missing default namespace ${DEFAULT_NAMESPACE} for ${DEFAULT_LOCALE}`);
}

for (const [locale, namespaces] of Object.entries(localeMessages)) {
  const localeNamespaces = Object.keys(namespaces);
  const missingNamespaces = defaultLocaleNamespaces.filter((namespace) => !localeNamespaces.includes(namespace));
  const extraNamespaces = localeNamespaces.filter((namespace) => !defaultLocaleNamespaces.includes(namespace));
  if (missingNamespaces.length > 0) {
    throw new Error(
      `Invalid ${locale} locale messages: missing namespace(s): ${missingNamespaces.join(", ")}`,
    );
  }
  if (extraNamespaces.length > 0) {
    throw new Error(
      `Invalid ${locale} locale messages: unexpected namespace(s): ${extraNamespaces.join(", ")}`,
    );
  }

  try {
    for (const namespace of defaultLocaleNamespaces) {
      assertValidLocaleMessages(
        namespaces[namespace],
        localeMessages[DEFAULT_LOCALE]?.[namespace],
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
}

export const supportedLocales = Object.keys(localeMessages).sort();
export const supportedNamespaces = [...defaultLocaleNamespaces].sort();

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, namespaces]) => [locale, namespaces]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
