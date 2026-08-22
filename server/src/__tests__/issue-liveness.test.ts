import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness } from "../services/issue-liveness.ts";
import { classifyIssueReviewPaths } from "../services/recovery/issue-graph-liveness.ts";
import type { IssueLivenessIssueInput } from "../services/issue-liveness.ts";

const companyId = "company-1";
const managerId = "manager-1";
const coderId = "coder-1";
const blockerId = "blocker-1";
const blockedId = "blocked-1";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: blockedId,
    companyId,
    identifier: "PAP-1703",
    title: "Parent work",
    status: "blocked",
    assigneeAgentId: coderId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionState: null,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: coderId,
    companyId,
    name: "Coder",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: managerId,
    ...overrides,
  };
}

const manager = agent({
  id: managerId,
  name: "CTO",
  role: "cto",
  reportsTo: null,
});

const blocks = [{ companyId, blockerIssueId: blockerId, blockedIssueId: blockedId }];

describe("issue graph liveness classifier", () => {
  it("detects a PAP-1703-style blocked chain with an unassigned blocker and stable incident key", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_unassigned_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: managerId,
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_unassigned_issue:${blockerId}`,
    });
  });

  it("does not use free-form executive role or name matching for recovery ownership", () => {
    const rootAgentId = "root-agent";
    const spoofedExecutiveId = "spoofed-executive";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Missing unblock work",
          status: "todo",
          assigneeAgentId: null,
          createdByAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [
        agent({
          id: spoofedExecutiveId,
          name: "Chief Executive Recovery",
          role: "cto",
          title: "CEO",
          reportsTo: rootAgentId,
        }),
        agent({
          id: rootAgentId,
          name: "Root Operator",
          role: "operator",
          title: null,
          reportsTo: null,
        }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.recommendedOwnerAgentId).toBe(rootAgentId);
    expect(findings[0]?.recommendedOwnerCandidates[0]).toMatchObject({
      agentId: rootAgentId,
      reason: "root_agent",
      sourceIssueId: blockerId,
    });
    expect(findings[0]?.recommendedOwnerCandidateAgentIds).toEqual([
      rootAgentId,
      spoofedExecutiveId,
    ]);
  });

  it("does not flag a live blocked chain with an active assignee and wake path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Live unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
      queuedWakeRequests: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "queued" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects an assigned backlog blocker leaf with no action path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Parked assigned unblock work",
          status: "backlog",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      identifier: "PAP-1703",
      state: "blocked_by_assigned_backlog_issue",
      recoveryIssueId: blockerId,
      recommendedOwnerAgentId: "blocker-agent",
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId, status: "backlog" }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_assigned_backlog_issue:${blockerId}`,
    });
  });

  it("does not flag an assigned backlog blocker that has an explicit waiting path", () => {
    const backlogBlocker = issue({
      id: blockerId,
      identifier: "PAP-1704",
      title: "Explicitly parked unblock work",
      status: "backlog",
      assigneeAgentId: "blocker-agent",
    });
    const baseInput = {
      issues: [issue(), backlogBlocker],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "blocker-agent", name: "Blocker Agent", reportsTo: managerId }),
      ],
    };

    expect(classifyIssueGraphLiveness({
      ...baseInput,
      issues: [issue(), { ...backlogBlocker, assigneeAgentId: null, assigneeUserId: "board-user-1" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      activeRuns: [{ companyId, issueId: blockerId, agentId: "blocker-agent", status: "running" }],
    })).toEqual([]);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      openRecoveryIssues: [{ companyId, issueId: blockerId, status: "todo" }],
    })).toEqual([]);
  });

  it("does not flag an unassigned blocker that already has an active execution path", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Unassigned but already running",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
      relations: blocks,
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: blockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toEqual([]);
  });

  it("detects cancelled blockers and uninvokable blocker assignees deterministically", () => {
    const cancelled = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(cancelled[0]?.state).toBe("blocked_by_cancelled_issue");

    const paused = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Paused unblock work",
          status: "todo",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Paused", status: "paused" })],
    });
    expect(paused[0]?.state).toBe("blocked_by_uninvokable_assignee");
  });

  it("detects a cancelled blocker on an assigned todo source", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "todo" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: blockedId,
      state: "blocked_by_cancelled_issue",
      recoveryIssueId: blockerId,
    });
  });

  it("prefers the blocker finding for an in-review source with a cancelled blocker", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({ status: "in_review" }),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Cancelled unblock work",
          status: "cancelled",
          assigneeAgentId: "blocker-agent",
        }),
      ],
      relations: blocks,
      agents: [agent(), manager, agent({ id: "blocker-agent", name: "Cancelled owner" })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.state).toBe("blocked_by_cancelled_issue");
  });

  it("detects blocker assignees under terminated org ancestors as uninvokable", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue(),
        issue({
          id: blockerId,
          identifier: "PAP-1704",
          title: "Invalid tree unblock work",
          status: "todo",
          assigneeAgentId: "qa-2",
        }),
      ],
      relations: blocks,
      agents: [
        agent(),
        manager,
        agent({ id: "qa-2", name: "QA 2", status: "active", reportsTo: "cto-2" }),
        agent({ id: "cto-2", name: "CTO 2", status: "terminated", reportsTo: "ceo-2" }),
        agent({ id: "ceo-2", name: "CEO 2", status: "terminated", reportsTo: null }),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "blocked_by_uninvokable_assignee",
      reason: "PAP-1703 is blocked by PAP-1704, but its assignee is in an invalid org chain.",
      recommendedOwnerAgentId: managerId,
    });
  });

  it("detects invalid in_review execution participant", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          status: "in_review",
          executionState: {
            status: "pending",
            currentStageId: "stage-1",
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: "missing-agent" },
            returnAssignee: { type: "agent", agentId: coderId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "invalid_review_participant",
      incidentKey: `harness_liveness:${companyId}:${blockedId}:invalid_review_participant:missing-agent`,
    });
  });

  it("detects the PAP-2239-style blocked chain at the first stalled in_review leaf without duplicate findings", () => {
    const phaseIssueId = "phase-issue-1";
    const reviewLeafId = "review-leaf-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: "pap-2239",
          identifier: "PAP-2239",
          title: "External object reference project",
          status: "blocked",
        }),
        issue({
          id: phaseIssueId,
          identifier: "PAP-2276",
          title: "UX acceptance review phase",
          status: "blocked",
          assigneeAgentId: coderId,
        }),
        issue({
          id: reviewLeafId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [
        { companyId, blockerIssueId: phaseIssueId, blockedIssueId: "pap-2239" },
        { companyId, blockerIssueId: reviewLeafId, blockedIssueId: phaseIssueId },
      ],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "pap-2239",
      identifier: "PAP-2239",
      state: "in_review_without_action_path",
      recoveryIssueId: reviewLeafId,
      recommendedOwnerAgentId: coderId,
      dependencyPath: [
        expect.objectContaining({ issueId: "pap-2239" }),
        expect.objectContaining({ issueId: phaseIssueId }),
        expect.objectContaining({ issueId: reviewLeafId }),
      ],
      incidentKey: `harness_liveness:${companyId}:pap-2239:in_review_without_action_path:${reviewLeafId}`,
    });
  });

  it("skips paused stalled review assignees when choosing recovery owner candidates", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent({ status: "paused" }), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recommendedOwnerAgentId: managerId,
    });
    expect(findings[0]?.recommendedOwnerCandidates).toEqual([
      {
        agentId: managerId,
        reason: "assignee_reporting_chain",
        sourceIssueId: reviewIssueId,
      },
    ]);
  });

  it("does not flag healthy in_review issues with an explicit action path", () => {
    const reviewIssueId = "review-1";
    const baseReviewIssue = issue({
      id: reviewIssueId,
      identifier: "PAP-2279",
      title: "Screenshot acceptance review",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: null,
    });

    const cases = [
      {
        name: "typed agent participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
            status: "pending",
            currentParticipant: { type: "agent", agentId: coderId },
          },
        },
      },
      {
        name: "typed user participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
            status: "pending",
            currentParticipant: { type: "user", userId: "board-user-1" },
          },
        },
      },
      {
        name: "user owner",
        issue: { ...baseReviewIssue, assigneeAgentId: null, assigneeUserId: "board-user-1" },
      },
      {
        name: "active run",
        issue: baseReviewIssue,
        activeRuns: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "running" }],
      },
      {
        name: "queued wake",
        issue: baseReviewIssue,
        queuedWakeRequests: [{ companyId, issueId: reviewIssueId, agentId: coderId, status: "queued" }],
      },
      {
        name: "pending interaction",
        issue: baseReviewIssue,
        pendingInteractions: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "pending approval",
        issue: baseReviewIssue,
        pendingApprovals: [{ companyId, issueId: reviewIssueId, status: "pending" }],
      },
      {
        name: "open recovery issue",
        issue: baseReviewIssue,
        openRecoveryIssues: [{ companyId, issueId: reviewIssueId, status: "todo" }],
      },
    ];

    for (const testCase of cases) {
      const findings = classifyIssueGraphLiveness({
        issues: [testCase.issue],
        relations: [],
        agents: [agent(), manager],
        activeRuns: testCase.activeRuns,
        queuedWakeRequests: testCase.queuedWakeRequests,
        pendingInteractions: testCase.pendingInteractions,
        pendingApprovals: testCase.pendingApprovals,
        openRecoveryIssues: testCase.openRecoveryIssues,
      });

      expect(findings, testCase.name).toEqual([]);
    }
  });

  it("does not treat a participant retained after changes are requested as an active review path", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: {
            status: "changes_requested",
            currentParticipant: { type: "agent", agentId: coderId },
          },
        }),
      ],
      relations: [],
      agents: [agent(), manager],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: reviewIssueId,
      state: "in_review_without_action_path",
    });
  });

  it("still flags a stalled in_review issue when its blocker has an active run", () => {
    const reviewIssueId = "review-1";
    const activeBlockerId = "active-blocker-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
        issue({
          id: activeBlockerId,
          identifier: "PAP-2280",
          title: "Active blocker",
          status: "in_progress",
          assigneeAgentId: coderId,
        }),
      ],
      relations: [{ companyId, blockerIssueId: activeBlockerId, blockedIssueId: reviewIssueId }],
      agents: [agent(), manager],
      activeRuns: [{ companyId, issueId: activeBlockerId, agentId: coderId, status: "running" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: reviewIssueId,
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });

  it("ignores cross-company waiting paths for stalled in_review issues", () => {
    const reviewIssueId = "review-1";

    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent(), manager],
      pendingInteractions: [{ companyId: "other-company", issueId: reviewIssueId, status: "pending" }],
      openRecoveryIssues: [{ companyId: "other-company", issueId: reviewIssueId, status: "todo" }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
  });
});

describe("in_review action-path staleness", () => {
  const reviewIssueId = "review-1";
  const now = new Date("2026-08-22T00:00:00.000Z");

  function agedReview(overrides: Record<string, unknown>, reviewTransitionAt: string) {
    return issue({
      id: reviewIssueId,
      identifier: "PAP-2279",
      title: "Screenshot acceptance review",
      status: "in_review",
      assigneeAgentId: coderId,
      executionState: null,
      reviewTransitionAt,
      // Fresh, and deliberately so: every case below must turn on the review clock, never
      // on when the issue was last touched.
      updatedAt: "2026-08-21T23:59:00.000Z",
      ...overrides,
    });
  }

  function classify(issueInput: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return classifyIssueGraphLiveness({
      issues: [issueInput],
      relations: [],
      agents: [agent(), manager],
      now,
      ...extra,
    });
  }

  it("flags a review whose human reviewer has gone quiet past the bound", () => {
    // The BRO-1631 shape: assigned to a person, untouched for weeks, and previously
    // reported as covered forever because a `human_reviewer` path existed.
    const findings = classify(
      agedReview({ assigneeAgentId: coderId, assigneeUserId: "board-user-1" }, "2026-07-27T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      state: "in_review_without_action_path",
      recoveryIssueId: reviewIssueId,
    });
    expect(findings[0]?.reason).toContain("human_reviewer");
  });

  it("leaves a recent human reviewer alone", () => {
    const findings = classify(
      agedReview({ assigneeAgentId: coderId, assigneeUserId: "board-user-1" }, "2026-08-21T00:00:00.000Z"),
    );

    expect(findings).toEqual([]);
  });

  it("flags a review whose only user participant has gone quiet past the bound", () => {
    const findings = classify(
      agedReview(
        {
          assigneeUserId: null,
          executionState: { status: "pending", currentParticipant: { type: "user", userId: "board-user-1" } },
        },
        "2026-07-28T00:00:00.000Z",
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "in_review_without_action_path" });
    expect(findings[0]?.reason).toContain("execution_participant");
  });

  it("flags a review whose only interaction has sat unanswered past the bound", () => {
    const findings = classify(agedReview({}, "2026-08-01T00:00:00.000Z"), {
      pendingInteractions: [
        { companyId, issueId: reviewIssueId, status: "pending", createdAt: "2026-08-01T00:00:00.000Z" },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("interaction");
  });

  it("flags a queued wake that never started", () => {
    // A wake request row is a path only while it is plausibly about to run. Left queued
    // for a day it is a dead path that still reads as coverage.
    const findings = classify(agedReview({}, "2026-08-20T00:00:00.000Z"), {
      queuedWakeRequests: [
        { companyId, issueId: reviewIssueId, agentId: coderId, status: "queued", createdAt: "2026-08-20T00:00:00.000Z" },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("queued_wake");
  });

  it("keeps a live path authoritative when a stale one sits beside it", () => {
    const findings = classify(
      agedReview({ assigneeUserId: "board-user-1" }, "2026-07-27T00:00:00.000Z"),
      {
        activeRuns: [
          { companyId, issueId: reviewIssueId, agentId: coderId, status: "running", createdAt: "2026-08-21T23:00:00.000Z" },
        ],
      },
    );

    expect(findings).toEqual([]);
  });

  it("exempts a scheduled monitor, which bounds itself through maxAttempts", () => {
    const findings = classify(
      agedReview(
        {
          executionPolicy: { monitor: { maxAttempts: 5 } },
          monitorNextCheckAt: "2026-08-22T06:00:00.000Z",
          monitorAttemptCount: 1,
        },
        "2026-07-01T00:00:00.000Z",
      ),
    );

    expect(findings).toEqual([]);
  });

  it("does not call any path stale when the issue carries no review clock", () => {
    // Callers that do not supply reviewTransitionAt keep the previous behaviour.
    const findings = classifyIssueGraphLiveness({
      issues: [
        issue({
          id: reviewIssueId,
          identifier: "PAP-2279",
          title: "Screenshot acceptance review",
          status: "in_review",
          assigneeAgentId: coderId,
          assigneeUserId: "board-user-1",
          executionState: null,
        }),
      ],
      relations: [],
      agents: [agent(), manager],
      now,
    });

    expect(findings).toEqual([]);
  });

  it("does not revive a quiet reviewer when unrelated activity touches the issue", () => {
    // The regression this column exists for. Comments — including the platform's own
    // re-triage sweeps — move `updatedAt`, and while that was the clock, a reviewer who
    // had done nothing for a month was renewed by the very automation sent to find them.
    const findings = classify(
      agedReview(
        { assigneeUserId: "board-user-1", updatedAt: "2026-08-22T00:00:00.000Z" },
        "2026-07-27T00:00:00.000Z",
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "in_review_without_action_path" });
    expect(findings[0]?.reason).toContain("human_reviewer");
  });

  it("keeps a long-running execution live however long the issue itself has been quiet", () => {
    // A run is aged by the run, never by the issue around it. An agent still working a
    // long job on an issue that entered review weeks ago must not be escalated as a dead
    // path while it is mid-flight.
    const findings = classify(
      agedReview({ assigneeUserId: "board-user-1" }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          { companyId, issueId: reviewIssueId, agentId: coderId, status: "running", createdAt: "2026-08-21T18:00:00.000Z" },
        ],
      },
    );

    expect(findings).toEqual([]);
  });

  it("keeps a run that is still producing output live past the active-run bound", () => {
    // Creation time is immutable, so a run that legitimately works for more than a day
    // would age out mid-flight if it were the only clock. The run's own progress is what
    // renews it — and unlike the issue's `updatedAt`, unrelated traffic cannot move it.
    const findings = classify(
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          {
            companyId,
            issueId: reviewIssueId,
            agentId: coderId,
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            lastActivityAt: "2026-08-21T23:30:00.000Z",
          },
        ],
      },
    );

    expect(findings).toEqual([]);
  });

  it("flags a run that has been silent past the bound however recently it was created", () => {
    const findings = classify(
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          {
            companyId,
            issueId: reviewIssueId,
            agentId: coderId,
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            lastActivityAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("active_run");
  });

  it("keeps a run parked in a scheduled retry live until that retry is due", () => {
    // `scheduled_retry` is an execution status. Such a run is not quiet — it is waiting for
    // a time the platform already set, and escalating it would fight its own retry.
    const findings = classify(
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          {
            companyId,
            issueId: reviewIssueId,
            agentId: coderId,
            status: "scheduled_retry",
            createdAt: "2026-08-15T00:00:00.000Z",
            lastActivityAt: "2026-08-15T00:00:00.000Z",
            waitingUntil: "2026-08-22T06:00:00.000Z",
          },
        ],
      },
    );

    expect(findings).toEqual([]);
  });

  it("flags a scheduled retry whose due time has already passed", () => {
    // The retry was supposed to fire and did not. Once the wait is behind us the row is
    // silent again, and the bound applies exactly as it would to any other dead path.
    const findings = classify(
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          {
            companyId,
            issueId: reviewIssueId,
            agentId: coderId,
            status: "scheduled_retry",
            createdAt: "2026-08-15T00:00:00.000Z",
            lastActivityAt: "2026-08-15T00:00:00.000Z",
            waitingUntil: "2026-08-16T00:00:00.000Z",
          },
        ],
      },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("active_run");
  });

  it("reports when a renewed path began, not when it last moved", () => {
    // `since` is the board's "waiting since" column. Renewing a path must not rewrite it,
    // or a run stuck retrying for a week would read as freshly started every sweep.
    const [path] = classifyIssueReviewPaths(
      {
        issues: [],
        relations: [],
        agents: [agent(), manager],
        now,
        activeRuns: [
          {
            companyId,
            issueId: reviewIssueId,
            agentId: coderId,
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            lastActivityAt: "2026-08-21T23:30:00.000Z",
          },
        ],
      },
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z") as IssueLivenessIssueInput,
    );

    expect(path).toMatchObject({ kind: "active_run", stale: false, since: "2026-08-19T00:00:00.000Z" });
  });

  it("never ages a row-backed path off the review clock when its own timestamp is missing", () => {
    // A caller that forgets to select `createdAt` must degrade to "unknown", not to
    // "stale". Aging this run off the review clock would report a live execution as no
    // action path at all.
    const findings = classify(
      agedReview({ assigneeUserId: null }, "2026-07-01T00:00:00.000Z"),
      {
        activeRuns: [
          { companyId, issueId: reviewIssueId, agentId: coderId, status: "running" },
        ],
      },
    );

    expect(findings).toEqual([]);
  });
});
