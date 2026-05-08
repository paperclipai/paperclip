import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const BASE_CONFIG = {
  repo: "acme/test-repo",
  host: "github.com",
  secretRef: "github-token",
  syncedGoalIds: [],
  dryRun: true,
};

describe("paperclip-github-sync plugin", () => {
  it("setup completes without error", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);
    expect(harness.logs.some((l) => l.level === "error")).toBe(false);
  });

  it("logs sanitised payload on issue.created — no PII fields, no state written", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.setConfig(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      { title: "Secret bug", assigneeUserId: "user-123" },
      { entityId: "iss-1", entityType: "issue", companyId: "co-1" },
    );

    const entry = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: received event (no-op)",
    );
    expect(entry).toBeDefined();
    expect(entry?.meta?.["entityId"]).toBe("iss-1");
    expect(entry?.meta?.["eventType"]).toBe("issue.created");
    // Payload fields must not leak into log meta
    expect(JSON.stringify(entry?.meta)).not.toContain("Secret bug");
    expect(JSON.stringify(entry?.meta)).not.toContain("assigneeUserId");

    // No state written — this is a no-op handler
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss-1", stateKey: "seen" })).toBeUndefined();
  });

  it("resolves goal-ancestor chain and includes it in the log", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      goals: [
        { id: "goal-child", companyId: "co-1", title: "Child Goal", level: "team", status: "active", parentId: "goal-parent", description: null, ownerAgentId: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "goal-parent", companyId: "co-1", title: "Parent Goal", level: "company", status: "active", parentId: null, description: null, ownerAgentId: null, createdAt: new Date(), updatedAt: new Date() },
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      { goalId: "goal-child" },
      { entityId: "iss-2", entityType: "issue", companyId: "co-1" },
    );

    const entry = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: received event (no-op)",
    );
    expect(entry).toBeDefined();
    const ancestors = entry?.meta?.["goalAncestors"] as Array<{ id: string; title: string }>;
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0]).toMatchObject({ id: "goal-child", title: "Child Goal" });
    expect(ancestors[1]).toMatchObject({ id: "goal-parent", title: "Parent Goal" });
  });

  it("handles issue.updated and goal.updated events", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.setConfig(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.updated", {}, { entityId: "iss-3", entityType: "issue", companyId: "co-1" });
    await harness.emit("goal.updated", {}, { entityId: "goal-1", entityType: "goal", companyId: "co-1" });

    const infoLogs = harness.logs.filter(
      (l) => l.level === "info" && l.message === "github-sync: received event (no-op)",
    );
    expect(infoLogs).toHaveLength(2);
  });
});
