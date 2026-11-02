import { t, useTranslation, i18n } from "@/i18n";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => { now = Date.now(); listeners.forEach(notify => notify()); }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
  };
}
export function useCoordinatorRelativeClock() {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
export function coordinatorRelativeLabel(value: string | Date, clock: number) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = Math.max(0, clock - timestamp);
  if (elapsed < 60_000) return t("nov02Root.justNow");
  if (elapsed < 3_600_000) return t("nov02Root.ago_m", { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("nov02Root.ago_h", { count: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 604_800_000) return t("nov02Root.ago_d", { count: Math.floor(elapsed / 86_400_000) });
  return new Date(value).toLocaleDateString(i18n.resolvedLanguage, { month: "short", day: "numeric", ...(new Date(value).getFullYear() !== new Date(clock).getFullYear() ? { year: "numeric" as const } : {}) });
}
export function CoordinatorRelativeTime({ value, className }: { value: string | Date; className?: string }) {
  useTranslation();
  const clock = useCoordinatorRelativeClock();
  const label = coordinatorRelativeLabel(value, clock);
  if (!label) return null;
  const date = new Date(value);
  const exact = date.toLocaleString(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "long" });
  return <time dateTime={date.toISOString()} title={exact} aria-label={exact} tabIndex={0} className={className}>{label}</time>;
}
