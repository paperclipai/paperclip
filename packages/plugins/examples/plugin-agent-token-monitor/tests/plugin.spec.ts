import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("agent-token-monitor plugin", () => {
  it("setup registers token-totals and runs data handlers", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);

    const totals = await harness.getData<{ rows: unknown[] }>("token-totals", { companyId: "company-1" });
    expect(totals.rows).toEqual([]);

    expect(harness.dbQueries.length).toBeGreaterThanOrEqual(1);
    const totalsSql = harness.dbQueries[0].sql;
    expect(totalsSql).toContain("cost_events");
    expect(totalsSql).toContain("input_tokens");
    expect(totalsSql).toContain("subscription_run_count");
    expect(harness.dbQueries[0].params).toContain("company-1");
  });

  it("runs data handler passes agentId filter when provided", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);

    const runsBefore = harness.dbQueries.length;
    await harness.getData<{ rows: unknown[] }>("runs", {
      companyId: "company-1",
      agentId: "agent-99",
    });

    const runsQuery = harness.dbQueries[runsBefore];
    expect(runsQuery.sql).toContain("heartbeat_runs");
    expect(runsQuery.params).toContain("agent-99");
  });

  it("health check returns ok", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});
