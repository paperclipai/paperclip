import { i18n, t } from "@/i18n";

const DAY = 86_400_000;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Localized time today, yesterday, a weekday within a week, then a short date. */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return date.toLocaleTimeString(i18n.resolvedLanguage === "ru" ? "ru-RU" : "en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return t("oct26Artifacts.yesterday");
  if (days < 7) return date.toLocaleDateString(i18n.resolvedLanguage === "ru" ? "ru-RU" : "en-US", { weekday: "long" });
  return date.toLocaleDateString(i18n.resolvedLanguage === "ru" ? "ru-RU" : "en-US", { month: "short", day: "numeric" });
}

/** Localized today, yesterday, a day count within a week, then a long date. */
export function panelDateLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return t("oct26Artifacts.today");
  if (days === 1) return t("oct26Artifacts.yesterday");
  if (days < 7) return t("oct26Artifacts.daysAgo", { count: days });
  return date.toLocaleDateString(i18n.resolvedLanguage === "ru" ? "ru-RU" : "en-US", { month: "long", day: "numeric" });
}

export const countLabel = (count: number) => t("oct26Artifacts.count", { count });

export function sizeLabel(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  const unit = bytes < 1024 ? "bytes" : bytes < 1024 * 1024 ? "kilobytes" : "megabytes";
  const value = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024);
  const digits = bytes < 1024 ? 0 : 1;
  const size = new Intl.NumberFormat(i18n.resolvedLanguage, { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const keys = { bytes: "oct26Artifacts.bytes", kilobytes: "oct26Artifacts.kilobytes", megabytes: "oct26Artifacts.megabytes" };
  return t(keys[unit], { size });
}
