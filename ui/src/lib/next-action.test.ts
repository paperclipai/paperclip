import { describe, expect, it } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticNode,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueScheduledRetry,
  IssueStatus,
  IssueSubtreeDiagnosticNode,
} from "@paperclipai/shared";
import {
  deriveNextAction,
  deriveSubtreeNodeBadge,
  isRunActiveForIssue,
  selectActionableLeafNodeId,
} from "./next-action";

function inboxAttention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: null,
    owner: { type: "agent", agentId: "a1", userId: null, label: "ClaudeCoder" },
    action: { label: "resolve the stalled chain", detail: "Wake QA or remove the blocker." },
    sourceIssue: null,
    leafIssue: {
      id: "leaf-1",
      identifier: "PAP-12921",
      title: "QA release verification",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: "qa-1",
      assigneeUserId: null,
    },
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function recoveryAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "rec-1",
    companyId: "c1",
    sourceIssueId: "i1",
    recoveryIssueId: "rec-issue-1",
    kind: "workspace_validation",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "a1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "workspace_divergence",
    fingerprint: "fp",
    evidence: {},
    nextAction: "Reissue the task in a clean isolated workspace.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

const scheduledRetry: IssueScheduledRetry = {
  runId: "run-1",
  status: "scheduled_retry",
  agentId: "a1",
  agentName: "ClaudeCoder",
  retryOfRunId: "run-0",
  scheduledRetryAt: "2026-07-08T00:10:00.000Z",
  scheduledRetryAttempt: 2,
  scheduledRetryReason: "transient_failure",
  retryExhaustedReason: null,
  error: null,
  errorCode: null,
};

function blockerDiagnostics(
  flags: IssueBlockerDiagnosticsResponse["blockers"][number]["flags"],
): IssueBlockerDiagnosticsResponse {
  return {
    issue: {
      id: "i1",
      identifier: "PAP-12915",
      title: "Release verify parallel",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    diagnosis: "Blocked by a done task that still gates dependents.",
    readiness: {
      allBlockersDone: true,
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerCount: 1,
    },
    blockers: [
      {
        id: "b1",
        identifier: "PAP-12920",
        title: "Release verify child",
        status: "done",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
        isUnresolved: false,
        isDependencyReady: false,
        isPendingFinalize: true,
        flags,
      },
    ],
    omittedUnauthorizedBlockerCount: 0,
    truncated: false,
    caps: { maxBlockers: 50 },
  };
}

describe("deriveNextAction", () => {
  it("returns none for terminal tasks", () => {
    const result = deriveNextAction({
      status: "done",
      blockedInboxAttention: inboxAttention(),
      activeRecoveryAction: recoveryAction(),
    });
    expect(result.lane).toBe("none");
  });

  it("puts a live run in Working now ahead of everything", () => {
    const result = deriveNextAction({
      status: "in_progress",
      hasLiveRun: true,
      activeRecoveryAction: recoveryAction(),
    });
    expect(result.lane).toBe("working_now");
    expect(result.live).toBe(true);
    expect(result.resolvedFrom).toBe("live_run");
  });

  it("treats a scheduled corrective wake as Working now (queued)", () => {
    const result = deriveNextAction({ status: "in_progress", scheduledRetry });
    expect(result.lane).toBe("working_now");
    expect(result.statement).toContain("Queued to wake");
    expect(result.resolvedFrom).toContain("scheduled_retry");
  });

  it("routes an active recovery action to the Recovery lane with attempt count", () => {
    const result = deriveNextAction({
      status: "in_progress",
      activeRecoveryAction: recoveryAction(),
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.lane).toBe("recovery");
    expect(result.statement).toContain("clean isolated workspace");
    expect(result.why).toContain("attempt 1/3");
    expect(result.primaryControl?.kind).toBe("open_recovery");
  });

  it("flags escalated recovery as recovery debt", () => {
    const result = deriveNextAction({
      status: "blocked",
      activeRecoveryAction: recoveryAction({ status: "escalated" }),
    });
    expect(result.lane).toBe("recovery");
    expect(result.recoveryDebt).toBe(true);
    expect(result.laneLabel).toBe("Recovery debt");
    expect(result.primaryControl?.kind).toBe("assign_worker");
  });

  it("routes a board owner to Waiting on a decision", () => {
    const result = deriveNextAction({
      status: "in_review",
      blockedInboxAttention: inboxAttention({
        state: "awaiting_decision",
        reason: "pending_board_decision",
        owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: { label: "accept or reject the plan", detail: null },
        leafIssue: null,
      }),
    });
    expect(result.lane).toBe("waiting_decision");
    expect(result.owner?.label).toBe("Board");
    expect(result.statement).toContain("Waiting for Board");
  });

  it("routes a needs-attention blocker chain to Blocked by real work", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(false);
    expect(result.references.some((r) => r.ref.identifier === "PAP-12921")).toBe(true);
  });

  it("marks a workspace-finalize gate as a terminal-gate blocked variant", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention(),
      blockerDiagnostics: blockerDiagnostics(["workspace_finalize_pending"]),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(true);
    expect(result.statement).toContain("Done");
    expect(
      result.references.some((r) => r.gate === "gate: workspace_finalize_pending"),
    ).toBe(true);
  });

  it("treats a stale Done blocker relation as recovery debt, not a terminal gate", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockerDiagnostics: blockerDiagnostics(["done_but_blocking"]),
    });
    expect(result.lane).toBe("recovery");
    expect(result.recoveryDebt).toBe(true);
    expect(result.terminalGate).toBe(false);
    expect(result.statement).toContain("Clear or replace");
    expect(result.references[0]?.gate).toBe("relation: done_but_blocking");
  });

  it("reveals a workspace-finalize terminal gate from diagnostics alone", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockerDiagnostics: blockerDiagnostics(["done_but_blocking", "workspace_finalize_pending"]),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(true);
    expect(result.terminalGates).toHaveLength(1);
  });

  it("returns none when nothing needs attention", () => {
    const result = deriveNextAction({ status: "in_progress" });
    expect(result.lane).toBe("none");
  });
});

describe("isRunActiveForIssue", () => {
  it("only marks the issue named by an active run scope", () => {
    const run = {
      status: "running",
      contextSnapshot: { issueId: "current-issue" },
    };
    expect(isRunActiveForIssue(run, "current-issue")).toBe(true);
    expect(isRunActiveForIssue(run, "historical-issue")).toBe(false);
  });

  it("does not treat a finished run as live for its scoped issue", () => {
    expect(isRunActiveForIssue(
      { status: "succeeded", contextSnapshot: { issueId: "current-issue" } },
      "current-issue",
    )).toBe(false);
  });
});

function blockerNode(
  overrides: Partial<IssueBlockerDiagnosticNode> = {},
): IssueBlockerDiagnosticNode {
  return {
    id: "b1",
    identifier: "PAP-900",
    title: "Upstream work",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    isUnresolved: true,
    isDependencyReady: false,
    isPendingFinalize: false,
    flags: [],
    ...overrides,
  };
}

function subtreeNode(
  overrides: Partial<IssueSubtreeDiagnosticNode> & {
    id?: string;
    identifier?: string;
    status?: IssueStatus;
  } = {},
): IssueSubtreeDiagnosticNode {
  const { id = "n1", identifier = "PAP-100", status = "in_progress", ...rest } = overrides;
  return {
    issue: {
      id,
      identifier,
      title: "A node",
      status,
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    parentId: null,
    depth: 0,
    diagnosis: null,
    likelyReason: null,
    blockers: [],
    blockerReadiness: null,
    omittedUnauthorizedBlockerCount: null,
    wakeEvents: [],
    wakeRequestCount: 0,
    activityRecordCount: 0,
    truncated: false,
    truncatedSections: { blockers: false, wakeRequests: false, activityRecords: false },
    ...rest,
  };
}

describe("deriveSubtreeNodeBadge", () => {
  it("mutes terminal nodes and never marks them actionable", () => {
    const badge = deriveSubtreeNodeBadge(subtreeNode({ status: "done" }));
    expect(badge.lane).toBe("none");
    expect(badge.laneLabel).toBe("Done");
    expect(badge.ready).toBe(false);
  });

  it("points a blocked node at its first unresolved blocker", () => {
    const badge = deriveSubtreeNodeBadge(
      subtreeNode({
        status: "blocked",
        blockers: [
          blockerNode({ id: "u1", identifier: "PAP-901" }),
          blockerNode({ id: "u2", identifier: "PAP-902" }),
        ],
      }),
    );
    expect(badge.lane).toBe("blocked_real_work");
    expect(badge.statement).toBe("Blocked → PAP-901 +1");
    expect(badge.target?.identifier).toBe("PAP-901");
    expect(badge.ready).toBe(false);
  });

  it("labels a workspace-finalize gate as a routed recovery", () => {
    const badge = deriveSubtreeNodeBadge(
      subtreeNode({
        status: "blocked",
        blockers: [
          blockerNode({
            status: "done",
            isUnresolved: false,
            isPendingFinalize: true,
            flags: ["workspace_finalize_pending"],
          }),
        ],
      }),
    );
    expect(badge.lane).toBe("recovery");
    expect(badge.laneLabel).toBe("Recovery");
    expect(badge.statement).toBe("Recovery → workspace gate");
    expect(badge.gate).toBe("gate: workspace_finalize_pending");
  });

  it("surfaces a cancelled blocker as recovery debt needing a worker", () => {
    const badge = deriveSubtreeNodeBadge(
      subtreeNode({
        status: "blocked",
        blockers: [
          blockerNode({
            status: "cancelled",
            isUnresolved: false,
            flags: ["cancelled_blocker_in_set"],
          }),
        ],
      }),
    );
    expect(badge.lane).toBe("recovery");
    expect(badge.laneLabel).toBe("Recovery debt");
    expect(badge.statement).toBe("Recovery debt → assign worker");
    expect(badge.accent).toBe("recovery_red");
  });

  it("treats a stale Done blocker relation as recovery debt", () => {
    const badge = deriveSubtreeNodeBadge(
      subtreeNode({
        status: "blocked",
        blockers: [
          blockerNode({
            status: "done",
            isUnresolved: false,
            flags: ["done_but_blocking"],
          }),
        ],
      }),
    );
    expect(badge.lane).toBe("recovery");
    expect(badge.laneLabel).toBe("Recovery debt");
    expect(badge.gate).toBe("relation: done_but_blocking");
  });

  it("does not infer active work from status without a live wake", () => {
    const badge = deriveSubtreeNodeBadge(subtreeNode({ status: "in_progress" }));
    expect(badge.lane).toBe("recovery");
    expect(badge.ready).toBe(false);
    expect(badge.statement).toBe("No live continuation.");
  });

  it("marks active work only when a queued wake provides live evidence", () => {
    const badge = deriveSubtreeNodeBadge(subtreeNode({
      status: "in_progress",
      wakeEvents: [{
        kind: "wake_request",
        agentId: "a1",
        source: "assigned",
        reason: "issue_assigned",
        status: "queued",
        coalescedCount: 0,
        runId: null,
        requestedAt: "2026-08-06T00:00:00.000Z",
        claimedAt: null,
        finishedAt: null,
        failureClass: null,
      }],
      wakeRequestCount: 1,
    }));
    expect(badge.lane).toBe("working_now");
    expect(badge.ready).toBe(true);
    expect(badge.resolvedFrom).toBe("live_wake");
  });

  it("marks an unblocked non-terminal node as ready to run", () => {
    const badge = deriveSubtreeNodeBadge(subtreeNode({ status: "todo" }));
    expect(badge.ready).toBe(true);
    expect(badge.lane).toBe("none");
  });
});

describe("selectActionableLeafNodeId", () => {
  it("prefers an unblocked leaf where work can move now", () => {
    const nodes = [
      subtreeNode({ id: "root", identifier: "PAP-1", status: "blocked", blockers: [blockerNode()] }),
      subtreeNode({ id: "leaf", identifier: "PAP-2", status: "todo" }),
    ];
    expect(selectActionableLeafNodeId(nodes)).toBe("leaf");
  });

  it("falls back to recovery-debt when nothing is unblocked", () => {
    const nodes = [
      subtreeNode({ id: "root", identifier: "PAP-1", status: "blocked", blockers: [blockerNode()] }),
      subtreeNode({
        id: "debt",
        identifier: "PAP-2",
        status: "blocked",
        blockers: [blockerNode({ status: "cancelled", isUnresolved: false, flags: ["cancelled_blocker_in_set"] })],
      }),
    ];
    expect(selectActionableLeafNodeId(nodes)).toBe("debt");
  });

  it("returns null when every node is done", () => {
    const nodes = [
      subtreeNode({ id: "a", status: "done" }),
      subtreeNode({ id: "b", status: "cancelled" }),
    ];
    expect(selectActionableLeafNodeId(nodes)).toBeNull();
  });

  it("does not select a ready parent when only its child is a leaf", () => {
    const nodes = [
      subtreeNode({ id: "parent", status: "todo" }),
      subtreeNode({ id: "child", status: "done", parentId: "parent", depth: 1 }),
    ];
    expect(selectActionableLeafNodeId(nodes)).toBeNull();
  });
});
