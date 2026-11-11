import { readStoredLocale } from "../i18n/preference";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

type ElapsedUnit = "m" | "h" | "d" | "w" | "mo";

/**
 * Counted ages ("1m ago", "2h ago") are not exact ru-labels keys.
 * `language` omitted follows paperclip.locale. ru and ru-RU both count.
 */
function clockIsRussian(language?: string | null): boolean {
  const code = language === undefined ? readStoredLocale() : language;
  return (code ?? "").toLowerCase().split("-")[0] === "ru";
}

export function justNowLabel(language?: string | null): string {
  return clockIsRussian(language) ? "только что" : "just now";
}

export function elapsedLabel(count: number, unit: ElapsedUnit, language?: string | null): string {
  if (!clockIsRussian(language)) {
    return unit === "mo" ? `${count}mo ago` : `${count}${unit} ago`;
  }
  const unitLabel = unit === "m" ? "мин"
    : unit === "h" ? "ч"
    : unit === "d" ? "д"
    : unit === "w" ? "нед"
    : "мес";
  return `${count} ${unitLabel} назад`;
}

export function timeAgo(date: Date | string, language?: string | null): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return justNowLabel(language);
  if (seconds < HOUR) return elapsedLabel(Math.floor(seconds / MINUTE), "m", language);
  if (seconds < DAY) return elapsedLabel(Math.floor(seconds / HOUR), "h", language);
  if (seconds < WEEK) return elapsedLabel(Math.floor(seconds / DAY), "d", language);
  if (seconds < MONTH) return elapsedLabel(Math.floor(seconds / WEEK), "w", language);
  return elapsedLabel(Math.floor(seconds / MONTH), "mo", language);
}
