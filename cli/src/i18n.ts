import { createTranslator, matchSupportedLocale, translateSystemMessage } from "@paperclipai/shared/i18n";
import { DEFAULT_LOCALE, type SupportedLocale } from "@paperclipai/shared";

function resolveCliLocale(): SupportedLocale {
  const candidates = [
    process.env.PAPERCLIP_LOCALE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];

  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate);
    if (matched) return matched;
  }

  return DEFAULT_LOCALE;
}

const locale = resolveCliLocale();
const translator = createTranslator(locale);

export function getCliLocale(): SupportedLocale {
  return locale;
}

export function cliT() {
  return translator;
}

export function localizeCliMessage(message: string): string {
  return translateSystemMessage(locale, message);
}
