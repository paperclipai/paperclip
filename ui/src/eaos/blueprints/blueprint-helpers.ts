// LET-501 — pure helpers for the Blueprint catalog/detail surfaces.
//
// Kept dependency-free so they can be tested in a node environment
// without React/router setup. The shape mirrors the LET-498 public
// catalog payload (see ui/src/api/blueprints.ts).

import type {
  BlueprintCatalogEntry,
  BlueprintCatalogListResponse,
} from "@/api/blueprints";

export type BlueprintFilterCategory = "all" | BlueprintCatalogEntry["category"];

export const BLUEPRINT_CATEGORY_LABEL: Record<
  BlueprintCatalogEntry["category"],
  string
> = {
  leadership: "Leadership",
  research: "Research",
  engineering: "Engineering",
  growth: "Growth",
  compliance: "Compliance",
  qa: "QA",
  integration: "Integration",
};

export const BLUEPRINT_FILTER_CATEGORIES: readonly BlueprintFilterCategory[] = [
  "all",
  "leadership",
  "research",
  "engineering",
  "growth",
  "compliance",
  "qa",
  "integration",
] as const;

export interface BlueprintCatalogFilters {
  search: string;
  category: BlueprintFilterCategory;
}

export const DEFAULT_FILTERS: BlueprintCatalogFilters = {
  search: "",
  category: "all",
};

export function filterCatalogEntries(
  entries: readonly BlueprintCatalogEntry[],
  filters: BlueprintCatalogFilters,
): BlueprintCatalogEntry[] {
  const needle = filters.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.category !== "all" && entry.category !== filters.category) {
      return false;
    }
    if (needle.length === 0) return true;
    const haystack = [
      entry.title,
      entry.description,
      entry.key,
      entry.ref,
      BLUEPRINT_CATEGORY_LABEL[entry.category],
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface BlueprintCatalogCountSummary {
  // Distinct refs returned by the backend in the current scope. We
  // deliberately do not invent "trending" / "popularity" / "success"
  // metrics — LET-497 §4 forbids them.
  loadedCount: number;
  visibleCount: number;
  // Distinct categories present in the loaded result set (not a global
  // category roster). Counts shown next to each category filter are
  // computed from the loaded versions only.
  perCategory: Array<{ category: BlueprintCatalogEntry["category"]; count: number }>;
}

export function summarizeCatalog(
  loaded: readonly BlueprintCatalogEntry[],
  visible: readonly BlueprintCatalogEntry[],
): BlueprintCatalogCountSummary {
  const counts = new Map<BlueprintCatalogEntry["category"], number>();
  for (const entry of loaded) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return {
    loadedCount: loaded.length,
    visibleCount: visible.length,
    perCategory: Array.from(counts.entries()).map(([category, count]) => ({
      category,
      count,
    })),
  };
}

export function isCatalogEnabled(payload: BlueprintCatalogListResponse | undefined): boolean {
  return Boolean(payload?.enabled);
}

// Permission policies derive their truth from the canonical Blueprint
// version object. We collapse them into a posture label per gate level
// so the UI can show how risky an instantiate would be without exposing
// raw policy keys to the operator chrome.
export interface BlueprintPermissionPosture {
  hasBoardGate: boolean;
  hasLeadGate: boolean;
  totalPolicies: number;
  hasLiveExternalActionRisk: boolean;
}

export function summarizePermissionPosture(
  entry: Pick<BlueprintCatalogEntry, "permissionPolicies">,
): BlueprintPermissionPosture {
  let hasBoardGate = false;
  let hasLeadGate = false;
  let hasLiveExternalActionRisk = false;
  for (const policy of entry.permissionPolicies) {
    if (policy.gate === "board") hasBoardGate = true;
    if (policy.gate === "lead") hasLeadGate = true;
    if (/live[_-]?send|live[_-]?apply|live[_-]?action|outreach|mcp\.install/i.test(policy.key)) {
      hasLiveExternalActionRisk = true;
    }
  }
  return {
    hasBoardGate,
    hasLeadGate,
    totalPolicies: entry.permissionPolicies.length,
    hasLiveExternalActionRisk,
  };
}
