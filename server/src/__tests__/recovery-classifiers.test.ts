import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness as classifyIssueGraphLivenessCompat } from "../services/issue-liveness.ts";
import { decideRunLivenessContinuation as decideRunLivenessContinuationCompat } from "../services/run-continuations.ts";
import {
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  RECOVERY_REASON_KINDS,
  buildIssueGraphLivenessIncidentKey,
  buildIssueGraphLivenessLeafKey,
  buildRunLivenessContinuationIdempotencyKey,
  classifyIssueGraphLiveness,
  clampAutonomousDispositionStatus,
  decideRunLivenessContinuation,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "../services/recovery/index.ts";

const companyId = "company-1";
const agentId = "agent-1";
const managerId = "manager-1";
const issueId = "issue-1";
const blockerId = "blocker-1";
const runId = "run-1";

describe("recovery classifier boundary", () => {
  it("keeps issue graph liveness classifier parity with the compatibility export", () => {
    const input = {
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2073",
          title: "Centralize recovery classifiers",
          status: "blocked",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
        {
          id: blockerId,
          companyId,
          identifier: "PAP-2074",
          title: "Move recovery side effects",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerIssueId: blockerId, blockedIssueId: issueId }],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    };

    expect(classifyIssueGraphLiveness(input)).toEqual(classifyIssueGraphLivenessCompat(input));
  });

  it("treats a scheduled monitor as an explicit review action path", () => {
    const findings = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2945",
          title: "Wait for external review",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("does not treat overdue or exhausted monitors as explicit waiting paths", () => {
    const baseIssue = {
      id: issueId,
      companyId,
      identifier: "PAP-2945",
      title: "Wait for external review",
      status: "in_review",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
    };
    const agents = [
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
      },
    ];

    const overdue = classifyIssueGraphLiveness({
      now: "2026-04-30T20:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents,
    });

    const exhausted = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionPolicy: {
            monitor: {
              nextCheckAt: "2026-04-30T19:00:00.000Z",
              maxAttempts: 1,
            },
          },
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
          monitorAttemptCount: 1,
        },
      ],
      relations: [],
      agents,
    });

    expect(overdue[0]?.state).toBe("in_review_without_action_path");
    expect(exhausted[0]?.state).toBe("in_review_without_action_path");
  });

  it("keeps run liveness continuation decision parity with the compatibility export", () => {
    const input = {
      run: {
        id: runId,
        companyId,
        agentId,
        continuationAttempt: 0,
      } as never,
      issue: {
        id: issueId,
        companyId,
        identifier: "PAP-2073",
        title: "Centralize recovery classifiers",
        status: "in_progress",
        assigneeAgentId: agentId,
        executionState: null,
        projectId: null,
      } as never,
      agent: {
        id: agentId,
        companyId,
        status: "idle",
      } as never,
      livenessState: "plan_only" as const,
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    };

    expect(decideRunLivenessContinuation(input)).toEqual(decideRunLivenessContinuationCompat(input));
  });

  it("keeps recovery origin and idempotency keys stable", () => {
    expect(RECOVERY_ORIGIN_KINDS).toMatchObject({
      issueGraphLivenessEscalation: "harness_liveness_escalation",
      strandedIssueRecovery: "stranded_issue_recovery",
      staleActiveRunEvaluation: "stale_active_run_evaluation",
    });
    expect(RECOVERY_REASON_KINDS.runLivenessContinuation).toBe("run_liveness_continuation");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident).toBe("harness_liveness");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf).toBe("harness_liveness_leaf");

    const incidentKey = buildIssueGraphLivenessIncidentKey({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      blockerIssueId: blockerId,
    });
    expect(incidentKey).toBe(
      "harness_liveness:company-1:issue-1:blocked_by_unassigned_issue:blocker-1",
    );
    expect(parseIssueGraphLivenessIncidentKey(incidentKey)).toEqual({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    });
    expect(buildIssueGraphLivenessLeafKey({
      companyId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    })).toBe("harness_liveness_leaf:company-1:blocked_by_unassigned_issue:blocker-1");
    expect(buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      nextAttempt: 1,
    })).toBe("run_liveness_continuation:issue-1:run-1:plan_only:1");
  });

  it("classifies stranded recovery origins as recovery-owned work", () => {
    expect(isStrandedIssueRecoveryOriginKind("stranded_issue_recovery")).toBe(true);
    expect(isStrandedIssueRecoveryOriginKind("harness_liveness_escalation")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind("manual")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind(null)).toBe(false);
  });

  it("does not flag a routine-backed in_review issue as having no action path", () => {
    const routineBackedAgents = [
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
      },
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        reportsTo: null,
      },
    ];

    const findings = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "SAG-4439",
          title: "Gamecam backfill monitor",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: routineBackedAgents,
      routineBackedIssueIds: new Set([issueId]),
    });

    expect(findings).toHaveLength(0);
  });

  it("still flags a non-routine-backed in_review issue with no action path (no fail-open)", () => {
    const findings = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "SAG-4439",
          title: "Gamecam backfill monitor",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    });

    expect(findings[0]?.state).toBe("in_review_without_action_path");
  });

  it("treats an issue with only archived/paused routines as not routine-backed (G1: active-status-only)", () => {
    // Simulates the DB query filtering routines.status = 'active':
    // archived/paused/cancelled routines must not count as a continuation path.
    // routineBackedIssueIds is empty because no active routines exist for this issue.
    const findings = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "SAG-4439",
          title: "Gamecam backfill monitor",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
      routineBackedIssueIds: new Set(), // empty: only archived/paused routines existed; those don't count
    });

    expect(findings[0]?.state).toBe("in_review_without_action_path");
  });

  it("cancel floor: autonomous recovery never emits cancelled (SAG-4478 defense-in-depth, holds routine-detection ON and OFF)", () => {
    // Routine-detection ON path: routine-backed issue produces no liveness finding → no disposal at all
    const findingsWithRoutineBacking = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "SAG-4439",
          title: "Gamecam backfill monitor",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: [
        { id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", reportsTo: managerId },
        { id: managerId, companyId, name: "CTO", role: "cto", status: "idle", reportsTo: null },
      ],
      routineBackedIssueIds: new Set([issueId]),
    });
    expect(findingsWithRoutineBacking).toHaveLength(0); // skipped; no disposition emitted

    // Routine-detection OFF path: non-routine-backed issue still fires recovery,
    // but the cancel floor ensures disposition is never 'cancelled'.
    expect(clampAutonomousDispositionStatus("cancelled")).toBe("blocked");
    expect(clampAutonomousDispositionStatus("blocked")).toBe("blocked");
    expect(clampAutonomousDispositionStatus("done")).toBe("done");
  });

  // SAG-4504 / SAG-4477 ADDED REQUIREMENT 2:
  // A routine_execution issue (the execution issue itself, e.g. SAG-4499) must be
  // recognized as live when its source routine is active. Previously the service only
  // protected the routine's *parent* issue (SAG-4439), not the execution children.

  it("does not flag a routine-execution issue whose source routine is active (SAG-4499 topology, AR2)", () => {
    // Simulates: service builds routineBackedIssueIds and, for AR2, includes the
    // execution issue's own ID when its source routine is active (status='active').
    // Topic: SAG-4499 shape — originKind=routine_execution, resting in_review/todo/unassigned.
    const executionIssueId = "routine-exec-issue-sag4499";
    const findings = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: executionIssueId,
          companyId,
          identifier: "SAG-4499",
          title: "Backfill progress check — routine execution",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: [
        { id: agentId, companyId, name: "Director", role: "engineer", status: "idle", reportsTo: managerId },
        { id: managerId, companyId, name: "CTO", role: "cto", status: "idle", reportsTo: null },
      ],
      // AR2: service populates this set with the execution issue's own ID
      // when its source routine (originId link or parentId fallback) is active.
      routineBackedIssueIds: new Set([executionIssueId]),
    });
    expect(findings).toHaveLength(0);
  });

  it("still flags a routine-execution issue whose source routine is not active (AR2 G1: active-status-only, fail-closed)", () => {
    // G1 guardrail: archived/paused/cancelled source routine does NOT protect
    // the execution issue. routineBackedIssueIds is empty → recovery proceeds.
    const executionIssueId = "routine-exec-issue-sag4499";
    const findings = classifyIssueGraphLiveness({
      now: "2026-06-21T12:00:00.000Z",
      issues: [
        {
          id: executionIssueId,
          companyId,
          identifier: "SAG-4499",
          title: "Backfill progress check — routine execution",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [],
      agents: [
        { id: agentId, companyId, name: "Director", role: "engineer", status: "idle", reportsTo: managerId },
        { id: managerId, companyId, name: "CTO", role: "cto", status: "idle", reportsTo: null },
      ],
      // Service leaves this empty: source routine is archived/paused → execution issue still recovered.
      routineBackedIssueIds: new Set(),
    });
    expect(findings[0]?.state).toBe("in_review_without_action_path");
  });
});
