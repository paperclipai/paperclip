import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin-obsidian", () => {
  it("registers sync-health data handler", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });

    harness.seed({
      companies: [
        {
          id: "comp_1",
          name: "Test Co",
          prefix: "TST",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ status: string }>("sync-health");
    expect(data.status).toBe("unconfigured");
  });

  it("registers sync-log data handler", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });

    harness.seed({
      companies: [
        {
          id: "comp_1",
          name: "Test Co",
          prefix: "TST",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ entries: unknown[] }>("sync-log");
    expect(data.entries).toEqual([]);
  });

  it("registers sync job handler", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });

    await plugin.definition.setup(harness.ctx);

    // Job should be registered — running it without config should log a warning
    // but not throw
    await expect(harness.runJob("obsidian-sync")).resolves.not.toThrow();
  });

  it("subscribes to issue and goal events", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
    });

    await plugin.definition.setup(harness.ctx);

    // Should handle events without errors
    await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
    await harness.emit("issue.updated", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
    await harness.emit("goal.created", { goalId: "goal_1" }, { entityId: "goal_1", entityType: "goal" });
    await harness.emit("goal.updated", { goalId: "goal_1" }, { entityId: "goal_1", entityType: "goal" });

    // Events handled without throwing
    expect(harness.logs.length).toBeGreaterThan(0);
  });

  it("validates config correctly", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });

    await plugin.definition.setup(harness.ctx);

    // Valid config with vault path
    const validResult = await plugin.definition.onValidateConfig!({
      vaultPath: "/tmp/vault",
      syncIntervalMinutes: 15,
    });
    expect(validResult.ok).toBe(true);
    expect(validResult.errors).toHaveLength(0);

    // Config with no vault or git — should warn
    const warnResult = await plugin.definition.onValidateConfig!({});
    expect(warnResult.warnings.length).toBeGreaterThan(0);

    // Invalid sync interval
    const invalidResult = await plugin.definition.onValidateConfig!({
      vaultPath: "/tmp/vault",
      syncIntervalMinutes: 0,
    });
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.errors.length).toBeGreaterThan(0);
  });

  it("reports healthy status", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });
});
