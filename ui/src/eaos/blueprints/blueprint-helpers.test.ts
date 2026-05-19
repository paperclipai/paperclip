// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { BlueprintCatalogEntry } from "@/api/blueprints";
import {
  BLUEPRINT_CATEGORY_LABEL,
  BLUEPRINT_FILTER_CATEGORIES,
  filterCatalogEntries,
  isCatalogEnabled,
  summarizeCatalog,
  summarizePermissionPosture,
} from "./blueprint-helpers";

function makeEntry(overrides: Partial<BlueprintCatalogEntry> = {}): BlueprintCatalogEntry {
  return {
    ref: overrides.ref ?? "code-implementer@1",
    key: overrides.key ?? "code-implementer",
    version: overrides.version ?? "1",
    title: overrides.title ?? "Code Implementer",
    category: overrides.category ?? "engineering",
    description: overrides.description ?? "Builds features with tests.",
    status: overrides.status ?? "published",
    requiredSkillRefs: overrides.requiredSkillRefs ?? ["test-driven-development"],
    mcpBundleRefs: overrides.mcpBundleRefs ?? [],
    requiredSecretInputs: overrides.requiredSecretInputs ?? [],
    requiredProviderKeys: overrides.requiredProviderKeys ?? [],
    permissionPolicies:
      overrides.permissionPolicies ?? [{ key: "repo.write", gate: "lead", reason: "Writes code." }],
    runtimeDefaults: overrides.runtimeDefaults ?? { adapter: "claude", modelProfile: "strong" },
    budget: overrides.budget ?? { maxRunsPerDay: 12, maxSpendCentsPerDay: 2500 },
    validationContract: overrides.validationContract ?? [],
  };
}

describe("blueprint-helpers", () => {
  describe("BLUEPRINT_FILTER_CATEGORIES", () => {
    it("includes the 'all' sentinel and matches the canonical AgentBlueprint categories", () => {
      expect(BLUEPRINT_FILTER_CATEGORIES[0]).toBe("all");
      // The category label keys (excluding 'all') must align with the
      // filter list so the UI never asks for a category we cannot render.
      for (const category of BLUEPRINT_FILTER_CATEGORIES.slice(1)) {
        // All non-'all' filter categories must have a human label.
        expect(BLUEPRINT_CATEGORY_LABEL[category as keyof typeof BLUEPRINT_CATEGORY_LABEL]).toBeTruthy();
      }
    });
  });

  describe("filterCatalogEntries", () => {
    const sample: readonly BlueprintCatalogEntry[] = [
      makeEntry({ ref: "ceo-pm@1", key: "ceo-pm", title: "CEO/PM", category: "leadership" }),
      makeEntry({
        ref: "research-analyst@1",
        key: "research-analyst",
        title: "Research Analyst",
        category: "research",
      }),
      makeEntry({
        ref: "code-implementer@1",
        key: "code-implementer",
        title: "Code Implementer",
        category: "engineering",
      }),
    ];

    it("returns everything when filters are default", () => {
      const result = filterCatalogEntries(sample, { search: "", category: "all" });
      expect(result.map((e) => e.ref)).toEqual(sample.map((e) => e.ref));
    });

    it("filters by category", () => {
      const result = filterCatalogEntries(sample, { search: "", category: "engineering" });
      expect(result.map((e) => e.ref)).toEqual(["code-implementer@1"]);
    });

    it("filters by search across title, ref, and description (case-insensitive)", () => {
      const titleHit = filterCatalogEntries(sample, { search: "implementer", category: "all" });
      expect(titleHit.map((e) => e.ref)).toEqual(["code-implementer@1"]);

      const refHit = filterCatalogEntries(sample, { search: "ANALYST", category: "all" });
      expect(refHit.map((e) => e.ref)).toEqual(["research-analyst@1"]);
    });

    it("intersects category and search filters", () => {
      const result = filterCatalogEntries(sample, {
        search: "ceo",
        category: "engineering",
      });
      expect(result).toEqual([]);
    });
  });

  describe("summarizeCatalog", () => {
    it("reports backend-loaded and visible counts truthfully", () => {
      const loaded = [
        makeEntry({ category: "engineering" }),
        makeEntry({ ref: "ceo-pm@1", key: "ceo-pm", category: "leadership" }),
      ];
      const visible = [loaded[0]!];
      const summary = summarizeCatalog(loaded, visible);
      expect(summary.loadedCount).toBe(2);
      expect(summary.visibleCount).toBe(1);
      const categories = summary.perCategory.map((entry) => entry.category).sort();
      expect(categories).toEqual(["engineering", "leadership"]);
    });

    it("does not invent popularity / activity / success metrics", () => {
      const summary = summarizeCatalog([], []);
      const keys = Object.keys(summary).sort();
      expect(keys).toEqual(["loadedCount", "perCategory", "visibleCount"]);
    });
  });

  describe("summarizePermissionPosture", () => {
    it("marks board gates and live-external-action risk when present", () => {
      const posture = summarizePermissionPosture({
        permissionPolicies: [
          { key: "outreach.live_send", gate: "board", reason: "Live outreach is externally visible." },
        ],
      });
      expect(posture.hasBoardGate).toBe(true);
      expect(posture.hasLeadGate).toBe(false);
      expect(posture.hasLiveExternalActionRisk).toBe(true);
      expect(posture.totalPolicies).toBe(1);
    });

    it("flags mcp.install as live-external-action risk because installs gate live tools", () => {
      const posture = summarizePermissionPosture({
        permissionPolicies: [
          { key: "mcp.install", gate: "board", reason: "MCP installs gate external tools." },
        ],
      });
      expect(posture.hasLiveExternalActionRisk).toBe(true);
    });

    it("does not invent risk when there are no policies", () => {
      const posture = summarizePermissionPosture({ permissionPolicies: [] });
      expect(posture.hasBoardGate).toBe(false);
      expect(posture.hasLeadGate).toBe(false);
      expect(posture.hasLiveExternalActionRisk).toBe(false);
      expect(posture.totalPolicies).toBe(0);
    });
  });

  describe("isCatalogEnabled", () => {
    it("treats an undefined or { enabled: false } payload as not enabled", () => {
      expect(isCatalogEnabled(undefined)).toBe(false);
      expect(isCatalogEnabled({ enabled: false, versions: [] })).toBe(false);
    });

    it("treats { enabled: true } as enabled even when versions array is empty", () => {
      expect(isCatalogEnabled({ enabled: true, versions: [] })).toBe(true);
    });
  });
});
