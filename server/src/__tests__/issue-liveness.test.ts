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
      recommendedOwnerAgentId: managerId,
      dependencyPath: [
        expect.objectContaining({ issueId: blockedId }),
        expect.objectContaining({ issueId: blockerId }),
      ],
      incidentKey: `harness_liveness:${companyId}:${blockedId}:blocked_by_unassigned_issue:${blockerId}`,
    });
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
});
