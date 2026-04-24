import { relativeTimeForLocale } from "./i18n";

export function timeAgo(date: Date | string): string {
  return relativeTimeForLocale(date);
}
