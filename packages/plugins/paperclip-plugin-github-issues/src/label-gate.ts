import type { GhLabel } from "./types.js";

export function hasEligibleLabel(labels: GhLabel[], gate: string): boolean {
  return labels.some((l) => l.name === gate);
}
