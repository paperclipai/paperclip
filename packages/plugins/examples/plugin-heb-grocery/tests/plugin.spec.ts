import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("HEB Grocery plugin", () => {
  it("starts up and exposes data endpoints", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    // config-status data endpoint should return defaults when no config is set
    const status = await harness.getData<{
      hasBearerToken: boolean;
      hasCookieAuth: boolean;
      storeNumber: string | null;
      shoppingContext: string;
    }>("config-status");
    expect(status.hasBearerToken).toBe(false);
    expect(status.hasCookieAuth).toBe(false);
    expect(status.storeNumber).toBeNull();
    expect(status.shoppingContext).toBe("EXPLORE_MY_STORE");
  });

  it("returns empty deals state before any refresh", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const deals = await harness.getData<{
      fetchedAt: string | null;
      weeklyAdText: string;
      productCount: number;
    }>("cached-deals");
    expect(deals.fetchedAt).toBeNull();
    expect(deals.productCount).toBe(0);
    expect(typeof deals.weeklyAdText).toBe("string");
  });

  it("tools return an error result when HEB credentials are not configured", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("heb_search_products", { query: "milk" });
    // Should fail gracefully with an error field, not throw
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
    expect((result as { error?: string }).error).toContain("bearer token not configured" );
  });

  it("health check passes", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });
});
