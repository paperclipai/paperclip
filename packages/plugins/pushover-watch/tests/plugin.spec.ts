import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin worker setup", () => {
  it("logs a warning and returns cleanly when no companies are configured", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);
    const warned = harness.logs.some(
      (l) => l.level === "warn" && l.message === "pushover_watch_no_companies_configured",
    );
    expect(warned).toBe(true);
  });
});
