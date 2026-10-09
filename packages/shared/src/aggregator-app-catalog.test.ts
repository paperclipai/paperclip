import { describe, expect, it } from "vitest";
import { AGGREGATOR_APP_CATALOG, COMPOSIO_APP_TOOLKITS, findComposioCatalogApp, findAggregatorApp } from "./aggregator-app-catalog.js";

describe("public aggregator app catalog", () => {
  it("indexes the full snapshots and merges provider routes for the same app", () => {
    expect(AGGREGATOR_APP_CATALOG.length).toBeGreaterThan(1500);
    const hubspot = findAggregatorApp("composio", "hubspot")!;
    expect(hubspot.routes.map((route) => route.provider)).toEqual(["composio", "arcade"]);
    expect(findAggregatorApp("arcade", "hubspot")).toBe(hubspot);
    expect(findAggregatorApp("composio", "made-up-toolkit")).toBeUndefined();
    expect(findAggregatorApp("executor", "hubspot")).toBeUndefined();
  });

  it("retains every upstream toolkit variant for discovery and maps it to an app card", () => {
    expect(COMPOSIO_APP_TOOLKITS.length).toBeGreaterThan(1500);
    expect(COMPOSIO_APP_TOOLKITS.every(toolkit => findComposioCatalogApp(toolkit))).toBe(true);
    expect(findComposioCatalogApp("circleback_mcp")?.name).toBe("Circleback");
    expect(findComposioCatalogApp("notion")?.name).toBe("Notion");
    expect(findComposioCatalogApp("made-up-toolkit")).toBeUndefined();
  });

  it("keeps real provider toolkit identifiers and public logo/evidence URLs", () => {
    expect(findAggregatorApp("composio", "active_campaign")?.routes[0]).toMatchObject({
      toolkit: "active_campaign", logoUrl: "https://logos.composio.dev/api/active_campaign",
    });
    for (const app of AGGREGATOR_APP_CATALOG) {
      expect(app.name).toBeTruthy();
      expect(new Set(app.routes.map((route) => route.provider)).size).toBe(app.routes.length);
      for (const route of app.routes) {
        expect(new URL(route.logoUrl).protocol).toBe("https:");
        expect(new URL(route.docsUrl).hostname).toBe(`docs.${route.provider}.dev`);
      }
    }
  });

  it.each([
    ["close", "closeio"],
    ["excel", "microsoft-excel"],
    ["one_drive", "microsoft-onedrive"],
    ["share_point", "microsoft-sharepoint"],
    ["square", "squareup-api"],
    ["twitter", "x"],
  ])("merges the same service despite different provider branding (%s)", (composioToolkit, arcadeToolkit) => {
    const app = findAggregatorApp("composio", composioToolkit)!;
    expect(findAggregatorApp("arcade", arcadeToolkit)).toBe(app);
    expect(app.routes.map((route) => route.provider)).toEqual(["composio", "arcade"]);
  });
});
