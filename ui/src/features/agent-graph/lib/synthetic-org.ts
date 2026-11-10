import type { HierarchyMember } from "./hierarchy";

export function syntheticOrg(count: number, fanout = 6): HierarchyMember[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    reportsTo: index === 0
      ? null
      : `00000000-0000-4000-8000-${String(Math.floor((index - 1) / fanout)).padStart(12, "0")}`,
  }));
}
