import { describe, expect, it, vi } from "vitest";

// Module-level mocks for the issue service and recovery-action service so we
// can spy on issuesSvc.update and observe whether the terminal-status guards
// short-circuit before any write happens.
const { issueUpdateSpy, ensureRecoveryActionSpy, enqueueWakeupSpy } = vi.hoisted(() => ({
  issueUpdateSpy: vi.fn(),
  ensureRecoveryActionSpy: vi.fn(),
  enqueueWakeupSpy: vi.fn(),
}));

vi.mock("../issues.js", async () => {
  const actual = await vi.importActual<typeof import("../issues.js")>("../issues.js");
  return {
    ...actual,
    issueService: () => ({
      update: issueUpdateSpy,
      existingUnresolvedBlockerIssueIds: async () => [],
    }),
  };
});

vi.mock("../issue-recovery-actions.js", async () => {
  const actual = await vi.importActual<typeof import("../issue-recovery-actions.js")>(
    "../issue-recovery-actions.js",
  );
  return {
    ...actual,
    issueRecoveryActionService: () => ({
      upsertSourceScoped: ensureRecoveryActionSpy,
    }),
  };
});

import { recoveryService } from "./service.js";

function makeDb(freshStatus: string | null) {
  const selectResult = freshStatus !== null ? [{ status: freshStatus }] : [];
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
  } as any;
}

function makeIssue(status: string) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "TST-1",
    title: "Test issue",
    status,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionState: null,
    parentId: null,
    metadata: null,
    originKind: null,
  } as any;
}

const latestRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "failed",
  errorCode: "process_lost",
  contextSnapshot: null,
  outputCount: 0,
  lastOutputAt: null,
} as any;

describe("escalateStrandedAssignedIssue — terminal-status race guard", () => {
  it("returns null and skips issuesSvc.update + recovery-action upsert when fresh DB status is done", async () => {
    issueUpdateSpy.mockReset();
    ensureRecoveryActionSpy.mockReset();
    const db = makeDb("done");
    const svc = recoveryService(db, { enqueueWakeup: enqueueWakeupSpy } as any);

    const result = await svc.escalateStrandedAssignedIssue({
      issue: makeIssue("in_progress"),
      previousStatus: "in_progress",
      latestRun,
    });

    expect(result).toBeNull();
    expect(issueUpdateSpy).not.toHaveBeenCalled();
    // The recovery-action upsert lives after the guard, so it must not run either —
    // this catches a regression where the guard is deleted but issuesSvc.update is
    // also removed: ensureRecoveryActionSpy would still get called.
    expect(ensureRecoveryActionSpy).not.toHaveBeenCalled();
  });

  it("returns null and skips issuesSvc.update + recovery-action upsert when fresh DB status is cancelled", async () => {
    issueUpdateSpy.mockReset();
    ensureRecoveryActionSpy.mockReset();
    const db = makeDb("cancelled");
    const svc = recoveryService(db, { enqueueWakeup: enqueueWakeupSpy } as any);

    const result = await svc.escalateStrandedAssignedIssue({
      issue: makeIssue("in_progress"),
      previousStatus: "in_progress",
      latestRun,
    });

    expect(result).toBeNull();
    expect(issueUpdateSpy).not.toHaveBeenCalled();
    expect(ensureRecoveryActionSpy).not.toHaveBeenCalled();
  });

  // Regression-detection note: the two tests above NO LONGER use a
  // `.catch(() => null)` swallow. If the guard at service.ts:2562 is removed,
  // the next line (`ensureSourceScopedStrandedRecoveryAction`) reaches into
  // the real DB through `resolveStrandedIssueRecoveryOwnerAgentId`, which
  // fails against the stub `db` here — the resulting unhandled rejection
  // surfaces as a failed test rather than a silently-green one.
});
