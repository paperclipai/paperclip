import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness as classifyIssueGraphLivenessCompat } from "../services/issue-liveness.ts";
import { decideRunLivenessContinuation as decideRunLivenessContinuationCompat } from "../services/run-continuations.ts";
import {
  LIVENESS_ALERT_ACTIONS,
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  RECOVERY_REASON_KINDS,
  buildRunErrorSignature,
  buildIssueGraphLivenessIncidentKey,
  buildIssueGraphLivenessLeafKey,
  buildRunLivenessContinuationIdempotencyKey,
  classifyIssueGraphLiveness,
  decideRunLivenessContinuation,
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

  it("keeps liveness alert action strings stable", () => {
    expect(LIVENESS_ALERT_ACTIONS).toMatchObject({
      snoozeCapExceeded: "recovery.liveness_alert.snooze_cap_exceeded",
      continuationDuplicateError: "recovery.liveness_alert.continuation_duplicate_error",
      issueGraphStaleWarning: "recovery.liveness_alert.issue_graph_stale_warning",
      issueGraphStaleAutoRecovery: "recovery.liveness_alert.issue_graph_stale_auto_recovery",
    });
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

  it("buildRunErrorSignature produces deterministic signatures", () => {
    expect(buildRunErrorSignature("adapter_error", "empty_response")).toBe("adapter_error|empty_response");
    expect(buildRunErrorSignature(null, "plan_only")).toBe("none|plan_only");
    expect(buildRunErrorSignature("timeout", null)).toBe("timeout|none");
    expect(buildRunErrorSignature(null, null)).toBeNull();
  });

  it("skips continuation on consecutive identical error signatures", () => {
    const base = {
      run: { id: runId, companyId, agentId, continuationAttempt: 0 } as never,
      issue: {
        id: issueId, companyId, identifier: "PAP-1", title: "Test",
        status: "in_progress", assigneeAgentId: agentId, executionState: null, projectId: null,
      } as never,
      agent: { id: agentId, companyId, status: "idle" } as never,
      livenessState: "empty_response" as const,
      livenessReason: "No output",
      nextAction: "Take action",
      budgetBlocked: false,
      idempotentWakeExists: false,
    };

    // Identical signatures → skip
    const skipResult = decideRunLivenessContinuation({
      ...base,
      priorRunErrorSignature: "none|empty_response",
      currentRunErrorSignature: "none|empty_response",
    });
    expect(skipResult.kind).toBe("skip");
    expect(skipResult.kind === "skip" && skipResult.reason).toContain("consecutive identical error signature");

    // Different signatures → enqueue
    const enqueueResult = decideRunLivenessContinuation({
      ...base,
      priorRunErrorSignature: "adapter_error|empty_response",
      currentRunErrorSignature: "none|empty_response",
    });
    expect(enqueueResult.kind).toBe("enqueue");

    // Null prior (first attempt) → enqueue
    const firstResult = decideRunLivenessContinuation({
      ...base,
      priorRunErrorSignature: null,
      currentRunErrorSignature: "none|empty_response",
    });
    expect(firstResult.kind).toBe("enqueue");

    // No signatures provided → enqueue (backward compatible)
    const noSigResult = decideRunLivenessContinuation(base);
    expect(noSigResult.kind).toBe("enqueue");
  });
});
