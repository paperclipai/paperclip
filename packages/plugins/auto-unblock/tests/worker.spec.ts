import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "comp-1";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "iss-1",
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    description: null,
    status: "todo" as const,
    priority: "medium" as const,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setupHarness() {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "issue.comments.read"],
    config: {},
  });
}

describe("auto-unblock plugin", () => {
  it("unblocks parent when last child is done", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const parent = makeIssue({ id: "parent-1", identifier: "PAP-100", status: "blocked" });
    const child = makeIssue({
      id: "child-1",
      identifier: "PAP-101",
      parentId: "parent-1",
      status: "done",
    });
    harness.seed({ issues: [parent, child] });

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: "child-1", entityType: "issue", companyId: COMPANY_ID },
    );

    const updated = await harness.ctx.issues.get("parent-1", COMPANY_ID);
    expect(updated?.status).toBe("todo");

    const comments = await harness.ctx.issues.listComments("parent-1", COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Auto-unblocked: all child issues resolved");
    expect(comments[0].body).toContain("PAP-101 (done)");
  });

  it("does not unblock parent when siblings still pending", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const parent = makeIssue({ id: "parent-1", identifier: "PAP-100", status: "blocked" });
    const child1 = makeIssue({
      id: "child-1",
      identifier: "PAP-101",
      parentId: "parent-1",
      status: "done",
    });
    const child2 = makeIssue({
      id: "child-2",
      identifier: "PAP-102",
      parentId: "parent-1",
      status: "in_progress",
    });
    harness.seed({ issues: [parent, child1, child2] });

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: "child-1", entityType: "issue", companyId: COMPANY_ID },
    );

    const updated = await harness.ctx.issues.get("parent-1", COMPANY_ID);
    expect(updated?.status).toBe("blocked");

    const comments = await harness.ctx.issues.listComments("parent-1", COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Still waiting on 1 other issue(s): PAP-102");
  });

  it("ignores issues without parentId", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const issue = makeIssue({ id: "iss-1", identifier: "PAP-1", status: "done", parentId: null });
    harness.seed({ issues: [issue] });

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: "iss-1", entityType: "issue", companyId: COMPANY_ID },
    );

    // Nothing should happen — no errors, no updates
    const updated = await harness.ctx.issues.get("iss-1", COMPANY_ID);
    expect(updated?.status).toBe("done");
  });

  it("ignores when parent is not blocked", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const parent = makeIssue({ id: "parent-1", identifier: "PAP-100", status: "in_progress" });
    const child = makeIssue({
      id: "child-1",
      identifier: "PAP-101",
      parentId: "parent-1",
      status: "done",
    });
    harness.seed({ issues: [parent, child] });

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: "child-1", entityType: "issue", companyId: COMPANY_ID },
    );

    const updated = await harness.ctx.issues.get("parent-1", COMPANY_ID);
    expect(updated?.status).toBe("in_progress");
  });

  it("handles cancelled child same as done", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const parent = makeIssue({ id: "parent-1", identifier: "PAP-100", status: "blocked" });
    const child = makeIssue({
      id: "child-1",
      identifier: "PAP-101",
      parentId: "parent-1",
      status: "cancelled",
    });
    harness.seed({ issues: [parent, child] });

    await harness.emit(
      "issue.updated",
      { status: "cancelled", _previous: { status: "in_progress" } },
      { entityId: "child-1", entityType: "issue", companyId: COMPANY_ID },
    );

    const updated = await harness.ctx.issues.get("parent-1", COMPANY_ID);
    expect(updated?.status).toBe("todo");

    const comments = await harness.ctx.issues.listComments("parent-1", COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("PAP-101 (cancelled)");
  });

  it("unblocks when all siblings are done/cancelled mix", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const parent = makeIssue({ id: "parent-1", identifier: "PAP-100", status: "blocked" });
    const child1 = makeIssue({
      id: "child-1",
      identifier: "PAP-101",
      parentId: "parent-1",
      status: "done",
    });
    const child2 = makeIssue({
      id: "child-2",
      identifier: "PAP-102",
      parentId: "parent-1",
      status: "cancelled",
    });
    harness.seed({ issues: [parent, child1, child2] });

    // child-1 just went done; child-2 was already cancelled
    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: "child-1", entityType: "issue", companyId: COMPANY_ID },
    );

    const updated = await harness.ctx.issues.get("parent-1", COMPANY_ID);
    expect(updated?.status).toBe("todo");

    const comments = await harness.ctx.issues.listComments("parent-1", COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Auto-unblocked: all child issues resolved");
  });
});
