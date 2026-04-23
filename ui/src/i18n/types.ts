import type { SupportedLocale } from "@paperclipai/shared";

export type UiLocale = SupportedLocale;
export type TranslateParams = Record<string, string | number>;
export type MessageCatalog = Record<string, string>;
