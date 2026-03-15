export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type TranslationMessages = Record<string, string>;

export type TranslationParams = Record<string, string | number | boolean | null | undefined>;
