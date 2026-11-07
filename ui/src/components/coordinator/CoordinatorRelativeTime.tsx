import { t as translateShell, useTranslation } from "@/i18n";
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
  const { t: translateShell } = useTranslation("shell");
  return useSyncExternalStore(subscribe, () => now, () => now);
}
export function coordinatorRelativeLabel(value: string | Date, clock: number) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = Math.max(0, clock - timestamp);
  if (elapsed < 60_000) return translateShell("shell:just_now");
  if (elapsed < 3_600_000) return translateShell("shell:m_ago", { value1: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return translateShell("shell:h_ago", { value1: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 604_800_000) return translateShell("shell:d_ago", { value1: Math.floor(elapsed / 86_400_000) });
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(value).getFullYear() !== new Date(clock).getFullYear() ? { year: "numeric" as const } : {}) });
}
export function CoordinatorRelativeTime({ value, className }: { value: string | Date; className?: string }) {
  const { t: translateShell } = useTranslation("shell");
  const clock = useCoordinatorRelativeClock();
  const label = coordinatorRelativeLabel(value, clock);
  if (!label) return null;
  const date = new Date(value);
  const exact = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
  return <time dateTime={date.toISOString()} title={exact} aria-label={exact} tabIndex={0} className={className}>{label}</time>;
}
