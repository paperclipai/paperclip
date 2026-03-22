import { describe, expect, it, vi, beforeEach } from "vitest";
import { issueService } from "../services/issues.js";

/**
 * Tests for QUA-12: release() must clear executionRunId, executionAgentNameKey,
 * and executionLockedAt so that a different agent can re-checkout the issue.
 */

function makeIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: "run-1",
    executionRunId: "run-1",
    executionAgentNameKey: "software agent 1",
    executionLockedAt: new Date("2026-03-20T00:00:00Z"),
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "TEST-1",
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-19T00:00:00Z"),
    updatedAt: new Date("2026-03-19T00:00:00Z"),
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function createDbStub(existing: Record<string, unknown> | null) {
  let capturedSetArg: Record<string, unknown> | null = null;

  const released = existing
    ? {
        ...existing,
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }
    : null;

  // select().from().where() chain for getById / release lookup
  // Also needs innerJoin chain for withIssueLabels: select().from().innerJoin().where().orderBy()
  const selectOrderBy = vi.fn(async () => []);
  const selectInnerJoinWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
  const selectInnerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
  const selectWhere = vi.fn(async () => (existing ? [existing] : []));
  const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // update().set().where().returning() chain
  const returning = vi.fn(async () => (released ? [released] : []));
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn((arg: Record<string, unknown>) => {
    capturedSetArg = arg;
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set }));

  const db = { select, update } as any;

  return { db, set, capturedSetArg: () => capturedSetArg };
}

describe("issue release clears execution fields (QUA-12)", () => {
  it("release() sets executionRunId, executionAgentNameKey, executionLockedAt to null", async () => {
    const existing = makeIssueRow();
    const { db, capturedSetArg } = createDbStub(existing);

    const svc = issueService(db);
    const result = await svc.release("issue-1", "agent-1", "run-1");

    expect(result).not.toBeNull();
    const setValues = capturedSetArg();
    expect(setValues).toBeTruthy();
    expect(setValues!.executionRunId).toBeNull();
    expect(setValues!.executionAgentNameKey).toBeNull();
    expect(setValues!.executionLockedAt).toBeNull();
    expect(setValues!.checkoutRunId).toBeNull();
    expect(setValues!.assigneeAgentId).toBeNull();
    expect(setValues!.status).toBe("todo");
  });

  it("after release, all execution lock fields are cleared in the returned object", async () => {
    const existing = makeIssueRow({
      executionRunId: "old-run",
      executionAgentNameKey: "old agent",
      executionLockedAt: new Date(),
    });
    const { db } = createDbStub(existing);

    const svc = issueService(db);
    const result = await svc.release("issue-1", "agent-1", "run-1");

    expect(result).not.toBeNull();
    expect(result!.executionRunId).toBeNull();
    expect(result!.executionAgentNameKey).toBeNull();
    expect(result!.executionLockedAt).toBeNull();
    expect(result!.checkoutRunId).toBeNull();
  });

  it("release returns null for non-existent issue", async () => {
    const { db } = createDbStub(null);
    const svc = issueService(db);
    const result = await svc.release("nonexistent");
    expect(result).toBeNull();
  });
});
