import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "comp-1";
const DEV_AGENT_ID = "f3bd3061-dev-agent";
const OPS_AGENT_ID = "24cbca9e-ops-agent";
const REV_AGENT_ID = "e487e433-rev-agent";

const PREFIX_MAP = {
  "🔧": DEV_AGENT_ID,
  "🚀": OPS_AGENT_ID,
  "✅": REV_AGENT_ID,
  "🎨": DEV_AGENT_ID,
};

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "iss-1",
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentId: null,
    title: "🔧 DEV Fix something",
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

function setupHarness(config: Record<string, unknown> = { prefixMap: PREFIX_MAP }) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config,
  });
  return harness;
}

describe("auto-assign plugin", () => {
  // AC1: issue.created with emoji prefix and no assignee → auto-assign matching agent
  it("auto-assigns agent when issue.created has emoji prefix and no assignee", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const issue = makeIssue({ id: "iss-1", title: "🔧 DEV Fix the bug", assigneeAgentId: null });
    harness.seed({ issues: [issue] });

    await harness.emit("issue.created", { issueId: "iss-1" }, {
      entityId: "iss-1",
      entityType: "issue",
      companyId: COMPANY_ID,
    });

    // Verify the issue was updated with the correct agent
    const updated = await harness.ctx.issues.get("iss-1", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBe(DEV_AGENT_ID);
  });

  it("auto-assigns OPS agent for 🚀 prefix", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const issue = makeIssue({ id: "iss-2", title: "🚀 OPS Deploy service", assigneeAgentId: null });
    harness.seed({ issues: [issue] });

    await harness.emit("issue.created", { issueId: "iss-2" }, {
      entityId: "iss-2",
      entityType: "issue",
      companyId: COMPANY_ID,
    });

    const updated = await harness.ctx.issues.get("iss-2", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBe(OPS_AGENT_ID);
  });

  // AC2: issue.created with existing assignee → do not overwrite
  it("does not overwrite existing assignee on issue.created", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const existingAssignee = "existing-agent-id";
    const issue = makeIssue({
      id: "iss-3",
      title: "🔧 DEV Already assigned task",
      assigneeAgentId: existingAssignee,
    });
    harness.seed({ issues: [issue] });

    await harness.emit("issue.created", { issueId: "iss-3" }, {
      entityId: "iss-3",
      entityType: "issue",
      companyId: COMPANY_ID,
    });

    const updated = await harness.ctx.issues.get("iss-3", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBe(existingAssignee);
  });

  // AC3: issue.created without emoji prefix → do not trigger
  it("does not assign when issue.created has no emoji prefix", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const issue = makeIssue({
      id: "iss-4",
      title: "Plain title without emoji",
      assigneeAgentId: null,
    });
    harness.seed({ issues: [issue] });

    await harness.emit("issue.created", { issueId: "iss-4" }, {
      entityId: "iss-4",
      entityType: "issue",
      companyId: COMPANY_ID,
    });

    const updated = await harness.ctx.issues.get("iss-4", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBeNull();
  });

  // AC4: issue.updated with assignee cleared (non-null → null) + emoji prefix → re-assign
  it("re-assigns when assignee is cleared on issue.updated with emoji prefix", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    // Issue currently has no assignee (it was just cleared)
    const issue = makeIssue({
      id: "iss-5",
      title: "🔧 DEV Task that was unassigned",
      assigneeAgentId: null,
    });
    harness.seed({ issues: [issue] });

    await harness.emit(
      "issue.updated",
      {
        issueId: "iss-5",
        _previous: { assigneeAgentId: "old-agent-id" }, // was assigned before
      },
      {
        entityId: "iss-5",
        entityType: "issue",
        companyId: COMPANY_ID,
      },
    );

    const updated = await harness.ctx.issues.get("iss-5", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBe(DEV_AGENT_ID);
  });

  // AC5: issue.updated with assignee cleared but no emoji prefix → do nothing
  it("does not re-assign when assignee cleared but no emoji prefix", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);

    const issue = makeIssue({
      id: "iss-6",
      title: "No emoji prefix here",
      assigneeAgentId: null,
    });
    harness.seed({ issues: [issue] });

    await harness.emit(
      "issue.updated",
      {
        issueId: "iss-6",
        _previous: { assigneeAgentId: "old-agent-id" },
      },
      {
        entityId: "iss-6",
        entityType: "issue",
        companyId: COMPANY_ID,
      },
    );

    const updated = await harness.ctx.issues.get("iss-6", COMPANY_ID);
    expect(updated?.assigneeAgentId).toBeNull();
  });
});
