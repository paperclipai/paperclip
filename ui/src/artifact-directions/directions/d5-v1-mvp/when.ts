/**
 * "Updated 4:05 PM" · "Updated Yesterday" · "Updated Monday" · "Updated Jan 23"
 * — the mock's four forms. The fixtures live in late September 2026, so the
 * lab's clock is pinned there; the product would use the real clock.
 */
export const LAB_NOW = new Date("2026-09-28T18:00:00");

const DAY = 86_400_000;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function updatedLabel(iso: string, now: Date = LAB_NOW): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const countLabel = (count: number) => `${count} ${count === 1 ? "Artifact" : "Artifacts"}`;

/** The side panel's form: "Today" · "Yesterday" · "2D ago" · "July 23". */
export function panelDateLabel(iso: string, now: Date = LAB_NOW): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}D ago`;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}
