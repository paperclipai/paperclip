import { describe, expect, it } from "vitest";
import { AGGREGATOR_APP_CATALOG } from "@paperclipai/shared/aggregator-app-catalog";
import { aggregatorPluginCategory, groupPluginsByCategory } from "./plugin-categories";
import { PLUGIN_CATEGORY_ORDER, type PluginCategoryId } from "./PluginMarketplace";

describe("aggregatorPluginCategory", () => {
  it("uses the provider's own category when the catalog states one", () => {
    expect(aggregatorPluginCategory({ name: "Anything", category: "development" })).toBe("developer");
    expect(aggregatorPluginCategory({ name: "Anything", category: "payments" })).toBe("commerce");
  });

  it("falls back to keywords in the name, and to Other when none match", () => {
    expect(aggregatorPluginCategory({ name: "Agile CRM" })).toBe("productivity");
    expect(aggregatorPluginCategory({ name: "Bulk Email Checker" })).toBe("communication");
    expect(aggregatorPluginCategory({ name: "Coinbase Wallet" })).toBe("commerce");
    expect(aggregatorPluginCategory({ name: "AllTrails" })).toBe("other");
  });

  it("carries Arcade categories through the shared catalog", () => {
    expect(AGGREGATOR_APP_CATALOG.some((app) => app.category === "productivity")).toBe(true);
  });
});

describe("groupPluginsByCategory", () => {
  it("classifies each app in the shipped catalog once", () => {
    expect(AGGREGATOR_APP_CATALOG.length).toBeGreaterThan(1000);
    let calls = 0;
    const categoryOf = (app: (typeof AGGREGATOR_APP_CATALOG)[number]): PluginCategoryId => {
      calls += 1;
      if (calls > AGGREGATOR_APP_CATALOG.length) throw new Error("Classified an app more than once");
      return aggregatorPluginCategory(app);
    };
    const groups = groupPluginsByCategory(AGGREGATOR_APP_CATALOG, PLUGIN_CATEGORY_ORDER, categoryOf, () => false, 9);
    expect(calls).toBe(AGGREGATOR_APP_CATALOG.length);
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(AGGREGATOR_APP_CATALOG.length);
    expect(groups.every((group) => group.rows.length <= 9)).toBe(true);
  });

  it("keeps category order, counts shelved rows and leaves them out of the block", () => {
    const items = [
      { key: "a", category: "developer" as const },
      { key: "b", category: "productivity" as const },
      { key: "c", category: "developer" as const },
      { key: "d", category: "developer" as const },
    ];
    const groups = groupPluginsByCategory(items, ["productivity", "developer", "other"], (item) => item.category, (item) => item.key === "a", 1);
    expect(groups).toEqual([
      { id: "productivity", total: 1, rows: [items[1]] },
      { id: "developer", total: 3, rows: [items[2]] },
    ]);
  });
});
