import { displayText } from "@/i18n/display-text";
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
  if (elapsed < 60_000) return displayText("Just now");
  if (elapsed < 3_600_000) return displayText("{{v0}}m ago", { v0: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return displayText("{{v0}}h ago", { v0: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 604_800_000) return displayText("{{v0}}d ago", { v0: Math.floor(elapsed / 86_400_000) });
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
