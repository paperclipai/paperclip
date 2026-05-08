import { describe, expect, it, vi, afterEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const BASE_CONFIG = {
  repo: "acme/test-repo",
  host: "github.com",
  secretRef: "github-token",
  syncedGoalIds: [],
  dryRun: true,
};

function makeIssue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "co-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    ...overrides,
  } as Issue;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("paperclip-github-sync plugin — worker", () => {
  it("setup completes without error", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);
    expect(harness.logs.some((l) => l.level === "error")).toBe(false);
  });

  it("dry-run: issue.created logs planned action without GH API call", async () => {
    vi.useFakeTimers();
    // Intercept globalThis.fetch so any accidental outbound call fails the test
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called in dry-run"));

    const harness = createTestHarness({ manifest });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-1", title: "Test issue", identifier: "GLA-9", companyId: "co-1" })],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      { goalId: undefined },
      { entityId: "iss-1", entityType: "issue", companyId: "co-1" },
    );

    // Debounce fires asynchronously; advance timers
    await vi.runAllTimersAsync();

    const dryLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: dry-run — would sync to GitHub",
    );
    expect(dryLog).toBeDefined();
    expect(dryLog?.meta?.["issueId"]).toBe("iss-1");
    expect(dryLog?.meta?.["action"]).toBe("create");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("out-of-scope issue: handler short-circuits before scheduleSync", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called for out-of-scope issue"));

    const harness = createTestHarness({ manifest });
    harness.setConfig({
      ...BASE_CONFIG,
      syncedGoalIds: ["root-a"],
      dryRun: false,
    });
    harness.seed({
      goals: [
        { id: "root-a", companyId: "co-1", title: "Root A", level: "company", status: "active", parentId: null, description: null, ownerAgentId: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "root-b", companyId: "co-1", title: "Root B", level: "company", status: "active", parentId: null, description: null, ownerAgentId: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "leaf-b", companyId: "co-1", title: "Leaf B", level: "team", status: "active", parentId: "root-b", description: null, ownerAgentId: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      issues: [makeIssue({ id: "iss-oos", title: "Out of scope issue", companyId: "co-1" })],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      { goalId: "leaf-b" },
      { entityId: "iss-oos", entityType: "issue", companyId: "co-1" },
    );

    await vi.runAllTimersAsync();

    const skipLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: issue out of synced goal subtree, skipping",
    );
    expect(skipLog).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    // No mapping written
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss-oos", namespace: "github-sync", stateKey: "gh-issue-number" })).toBeUndefined();
  });

  it("issue with no goalId skips when syncedGoalIds is configured", async () => {
    const harness = createTestHarness({ manifest });
    harness.setConfig({ ...BASE_CONFIG, syncedGoalIds: ["root-a"] });
    harness.seed({
      issues: [makeIssue({ id: "iss-nogoal", title: "No goal", companyId: "co-1" })],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      {},
      { entityId: "iss-nogoal", entityType: "issue", companyId: "co-1" },
    );

    const skipLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: issue has no goalId — out of synced goal subtree, skipping",
    );
    expect(skipLog).toBeDefined();
  });

  it("goal.updated invalidates subtree cache", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.setConfig(BASE_CONFIG);
    await plugin.definition.setup(harness.ctx);

    await harness.emit("goal.updated", {}, { entityId: "goal-1", entityType: "goal", companyId: "co-1" });

    const goalLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: goal.updated — cache invalidated",
    );
    expect(goalLog).toBeDefined();
    expect((goalLog?.meta as Record<string, unknown>)?.["entityId"]).toBe("goal-1");
  });

  it("issue.updated routes through the same handler as issue.created", async () => {
    vi.useFakeTimers();
    const harness = createTestHarness({ manifest });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-upd", title: "Updated issue", identifier: "GLA-11", companyId: "co-1" })],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.updated",
      {},
      { entityId: "iss-upd", entityType: "issue", companyId: "co-1" },
    );
    await vi.runAllTimersAsync();

    const dryLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: dry-run — would sync to GitHub",
    );
    expect(dryLog).toBeDefined();
    expect(dryLog?.meta?.["issueId"]).toBe("iss-upd");
  });
});
