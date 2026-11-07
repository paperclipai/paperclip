import { i18n, t } from "@/i18n";

const dateLocale = () => i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en-US";
const DAY = 86_400_000;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** The Artifacts page's form: "4:05 PM" · "Yesterday" · "Monday" · "Sep 12". */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return date.toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });
  if (days === 1) return t("activity-ui:artifact.yesterday");
  if (days < 7) return date.toLocaleDateString(dateLocale(), { weekday: "long" });
  return date.toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
}

/** The panel row's form: "Today" · "Yesterday" · "2D ago" · "July 23". */
export function panelDateLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return t("activity-ui:artifact.today");
  if (days === 1) return t("activity-ui:artifact.yesterday");
  if (days < 7) return t("activity-ui:artifact.daysAgo", { count: days });
  return date.toLocaleDateString(dateLocale(), { month: "long", day: "numeric" });
}

// Preserve the helper's original exact-one predicate, including unusual inputs.
export const countLabel = (count: number) => t(
  count === 1 ? "activity-ui:artifact.count_one" : "activity-ui:artifact.count_other",
  { count },
);

export function sizeLabel(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
