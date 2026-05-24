import { t } from "@/i18n";

export function formatMonitorOffset(nextCheckAt: Date | string): string {
  const deltaMs = new Date(nextCheckAt).getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000);
  if (absMinutes <= 0) return t("time.now", { defaultValue: "now" });
  if (absMinutes < 60) {
    return deltaMs >= 0
      ? t("time.inMinutes", { defaultValue: "in {{count}}m", count: absMinutes })
      : t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: absMinutes });
  }

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) {
    return deltaMs >= 0
      ? t("time.inHours", { defaultValue: "in {{count}}h", count: absHours })
      : t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: absHours });
  }

  const absDays = Math.round(absHours / 24);
  return deltaMs >= 0
    ? t("time.inDays", { defaultValue: "in {{count}}d", count: absDays })
    : t("time.daysAgo", { defaultValue: "{{count}}d ago", count: absDays });
}
