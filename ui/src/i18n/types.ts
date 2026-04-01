export const ACTIVE_LOCALES = ["en", "ko", "ja"] as const;
export type ActiveLocale = (typeof ACTIVE_LOCALES)[number];

export type MessageTree = {
  [key: string]: string | MessageTree;
};
