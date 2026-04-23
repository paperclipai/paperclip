import type { MessageCatalog, TranslateParams, UiLocale } from "./types";

const PARAM_PATTERN = /\{(\w+)\}/g;

export function translate(
  key: string,
  locale: UiLocale,
  catalogs: Record<UiLocale, MessageCatalog>,
  params?: TranslateParams,
) {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  return template.replace(PARAM_PATTERN, (_match, token) => String(params?.[token] ?? `{${token}}`));
}
