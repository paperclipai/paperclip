import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness } from "../services/issue-liveness.ts";

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
            currentParticipant: { type: "agent", agentId: coderId },
          },
        },
      },
      {
        name: "typed user participant",
        issue: {
          ...baseReviewIssue,
          executionState: {
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
