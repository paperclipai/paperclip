import { describe, expect, it } from "vitest";
import { AGGREGATOR_APP_CATALOG } from "@paperclipai/shared/aggregator-app-catalog";
import { aggregatorPluginCategory } from "./plugin-categories";

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
