import { useSyncExternalStore } from "react";
import { readStoredLocale } from "@/i18n/preference";

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
function coordinatorClockIsRussian(): boolean {
  return readStoredLocale().toLowerCase().split("-")[0] === "ru";
}
export function coordinatorRelativeLabel(value: string | Date, clock: number) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = Math.max(0, clock - timestamp);
  const russian = coordinatorClockIsRussian();
  if (elapsed < 60_000) return russian ? "Только что" : "Just now";
  if (elapsed < 3_600_000) {
    const n = Math.floor(elapsed / 60_000);
    return russian ? `${n} мин назад` : `${n}m ago`;
  }
  if (elapsed < 86_400_000) {
    const n = Math.floor(elapsed / 3_600_000);
    return russian ? `${n} ч назад` : `${n}h ago`;
  }
  if (elapsed < 604_800_000) {
    const n = Math.floor(elapsed / 86_400_000);
    return russian ? `${n} д назад` : `${n}d ago`;
  }
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(value).getFullYear() !== new Date(clock).getFullYear() ? { year: "numeric" as const } : {}) });
}
export function CoordinatorRelativeTime({ value, className }: { value: string | Date; className?: string }) {
  const clock = useCoordinatorRelativeClock();
  const label = coordinatorRelativeLabel(value, clock);
  if (!label) return null;
  const date = new Date(value);
  const exact = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
  return <time dateTime={date.toISOString()} title={exact} aria-label={exact} tabIndex={0} className={className}>{label}</time>;
}
