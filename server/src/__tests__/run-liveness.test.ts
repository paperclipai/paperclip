import { describe, expect, it } from "vitest";
import { classifyRunLiveness } from "../services/run-liveness.ts";
import {
  decideRunLivenessContinuation,
  decideSuccessfulRunHandoff,
} from "../services/recovery/index.ts";

const companyId = "company-1";
const agentId = "agent-1";

const baseInput = {
  runStatus: "succeeded",
  issue: {
    status: "in_progress",
    title: "Implement feature",
    description: "Add the requested behavior.",
  },
  resultJson: null,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  error: null,
  errorCode: null,
  continuationAttempt: 0,
  evidence: null,
};

describe("run liveness classifier", () => {
  it("classifies text-only future work as plan_only", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next and then implement the fix.",
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toContain("inspect the repo");
  });

  it("classifies empty successful output as empty_response", () => {
    const classification = classifyRunLiveness(baseInput);

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.actionability).toBe("unknown");
  });

  it("treats issue comments, documents, products, and actions as progress", () => {
    const latestEvidenceAt = new Date("2026-04-18T12:00:00Z");
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Updated implementation.",
      },
      evidence: {
        issueCommentsCreated: 1,
        documentRevisionsCreated: 1,
        workProductsCreated: 1,
        toolOrActionEventsCreated: 1,
        latestEvidenceAt,
      },
    });

    expect(classification.livenessState).toBe("advanced");
    expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
  });

  it("does not treat workspace operations alone as concrete progress", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next.",
      },
      evidence: {
        workspaceOperationsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.lastUsefulActionAt).toBeNull();
  });

  it("exempts planning/document tasks from plan-only retry classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        status: "in_progress",
        title: "Draft implementation plan",
        description: "Create a plan for the work.",
      },
      resultJson: {
        summary: "Plan:\n- Inspect files\n- Implement after approval",
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("exempts runs that update the plan document from plan-only classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next steps:\n- inspect files\n- implement the service",
      },
      evidence: {
        documentRevisionsCreated: 1,
        planDocumentRevisionsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("classifies done issues as completed", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        ...baseInput.issue,
        status: "done",
      },
      resultJson: {
        summary: "Finished the implementation.",
      },
    });

    expect(classification.livenessState).toBe("completed");
  });

  it("classifies declared blockers as blocked", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I cannot proceed because I need access credentials.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("blocked_external");
  });

  it("treats PAP-2000-style validation output as runnable follow-up, not an external blocker", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "PAP-1949 remains blocked until PAP-2000 is resolved.",
      },
      issueCommentBodies: [
        [
          "Validation is ready for the next pass.",
          "",
          "- Blocked chain context: PAP-1949 -> PAP-1999 -> PAP-2000",
          "- Next action: run npm test and report the row counts.",
        ].join("\n"),
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run npm test and report the row counts.");
  });

  it("prefers durable comments over raw transcript next-action noise", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issueCommentBodies: ["Next action: run pnpm test -- --runInBand."],
      stdoutExcerpt: [
        "tool_call: write",
        "command: rm -rf production-data",
        "Next action: deploy to production",
      ].join("\n"),
    });

    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run pnpm test -- --runInBand.");
  });

  it("keeps approval requests out of automatic continuation", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: wait for board approval before continuing.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("approval_required");
    expect(classification.nextAction).toBe("wait for board approval before continuing.");
  });

  it("routes production-sensitive next actions to manager review", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: deploy to production and verify live traffic.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("manager_review");
    expect(classification.nextAction).toBe("deploy to production and verify live traffic.");
  });


  it("uses killed background-task evidence instead of a generic failed-run reason", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      errorCode: "process_lost",
      resultJson: {
        stopReason: "unmanaged_background_task_stopped",
        unmanagedBackgroundTask: {
          kind: "orphaned_process_group_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
        },
      },
    });

    expect(classification.livenessState).toBe("failed");
    expect(classification.livenessReason).toBe("unmanaged background task stopped; no durable live path");
  });

  it("marks unclear useful output as unknown actionability", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Observed mixed output and left notes for a later pass.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("unknown");
    expect(classification.nextAction).toBeNull();
  });
});

describe("terminal no-direct-report 1:1 receipts (SON-699 / SON-641 shape)", () => {
  const terminalReceiptInput = {
    ...baseInput,
    issue: {
      status: "in_progress",
      title: "Routine: direct-report 1:1 conversation check",
      description: "Check 1:1 conversations for this routine window against live roster data.",
    },
    resultJson: {
      summary: [
        "Roster/session check complete against live data.",
        "Direct reports found: 0 (zero direct reports).",
        "Preserved dated no-conversation receipt at 2026-08-26T20:00Z.",
        "Action ledger: empty",
      ].join("\n"),
    },
  };

  it("classifies an explicit empty action ledger as terminal, never plan-only", () => {
    const classification = classifyRunLiveness(terminalReceiptInput);

    expect(classification.livenessState).toBe("completed");
    expect(classification.livenessReason).toContain("empty action ledger");
    expect(classification.nextAction).toBeNull();
  });

  it("replays the same terminal result with the identical classification", () => {
    const first = classifyRunLiveness(terminalReceiptInput);
    const second = classifyRunLiveness(terminalReceiptInput);

    expect(second).toEqual(first);
    expect(first.livenessState).toBe("completed");
  });

  it("does not surface a none-like labeled next action as actionable", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Reviewed the routine window; nothing pending.\nNext: none",
      },
    });

    expect(classification.nextAction).toBeNull();
  });

  it("does not record a multiline none fallback line as a next action", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Reviewed the routine window; nothing pending.\nNext:\nnone",
      },
    });

    expect(classification.nextAction).toBeNull();
  });

  it("keeps a required continuation when a structured next action accompanies an empty-ledger phrase", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Roster/session check complete against live data.\nAction ledger: empty",
        nextAction: "Update the tenant migration runbook with the rollback steps.",
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.nextAction).toContain("Update the tenant migration runbook");
  });

  it("still classifies an empty-ledger receipt with a none-like structured next action as terminal", () => {
    const classification = classifyRunLiveness({
      ...terminalReceiptInput,
      resultJson: {
        ...terminalReceiptInput.resultJson,
        nextAction: "none",
      },
    });

    expect(classification.livenessState).toBe("completed");
    expect(classification.nextAction).toBeNull();
  });

  it("keeps plan-only classification when an empty-ledger phrase coexists with real future-work intent", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: [
          "Wrote up findings. Action ledger: empty for this ticket.",
          "Next I'll inspect the flaky auth suite and fix the token refresh path.",
        ].join("\n"),
      },
    });

    expect(classification.livenessState).toBe("plan_only");
  });

  it("produces no corrective liveness continuation wake for a terminal receipt", () => {
    const classification = classifyRunLiveness(terminalReceiptInput);
    const decision = decideRunLivenessContinuation({
      run: {
        id: "run-1",
        companyId,
        agentId,
        continuationAttempt: 0,
      } as never,
      issue: {
        id: "issue-1",
        companyId,
        identifier: "RTN-1",
        title: "Routine: direct-report 1:1 conversation check",
        status: "done",
        assigneeAgentId: agentId,
        executionState: null,
        projectId: null,
      } as never,
      agent: { id: agentId, companyId, status: "idle" } as never,
      livenessState: classification.livenessState,
      livenessReason: classification.livenessReason,
      nextAction: classification.nextAction,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({ kind: "skip", reason: "liveness state is not actionable for continuation" });
  });

  it("produces no missing-disposition handoff wake when the routine stays done", () => {
    const decision = decideSuccessfulRunHandoff({
      run: {
        id: "run-1",
        companyId,
        agentId,
        status: "succeeded",
      } as never,
      issue: {
        id: "issue-1",
        companyId,
        identifier: "RTN-1",
        title: "Routine: direct-report 1:1 conversation check",
        description: null,
        originKind: null,
        status: "done",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        executionState: null,
      } as never,
      agent: { id: agentId, companyId, status: "idle" } as never,
      livenessState: "completed",
      detectedProgressSummary: null,
      finalReport: null,
      nextAction: null,
      taskKey: null,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("skip");
    expect((decision as { reason?: string }).reason).toContain("valid disposition");
  });
});
