import { describe, expect, it } from "vitest";
import {
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildFinishSuccessfulRunHandoffIdempotencyKey,
  buildSuccessfulRunHandoffExhaustedNotice,
  buildSuccessfulRunHandoffRequiredNotice,
  decideSuccessfulRunHandoff,
  isIdempotentFinishSuccessfulRunHandoffWakeStatus,
  isSuccessfulRunHandoffRequiredNoticeBody,
  noticeMetadataReferencesRecoveryAction,
} from "./successful-run-handoff.js";

const run = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  contextSnapshot: { issueId: "issue-1" },
} as any;

const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Finish backend handoff",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  executionState: null,
} as any;

const agent = {
  id: "agent-1",
  companyId: "company-1",
  status: "idle",
} as any;

function decide(overrides: Partial<Parameters<typeof decideSuccessfulRunHandoff>[0]> = {}) {
  return decideSuccessfulRunHandoff({
    run,
    issue,
    agent,
    livenessState: "advanced",
    detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    taskKey: "issue-1",
    hasActiveExecutionPath: false,
    hasQueuedWake: false,
    hasPendingInteractionOrApproval: false,
    hasExplicitBlockerPath: false,
    hasOpenRecoveryIssue: false,
    hasPauseHold: false,
    budgetBlocked: false,
    idempotentWakeExists: false,
    ...overrides,
  });
}

describe("successful run handoff decision", () => {
  it("queues one corrective handoff wake for a successful progress run without a visible next action", () => {
    const decision = decide();

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.idempotencyKey).toBe("finish_successful_run_handoff:issue-1:run-1:1");
    expect(decision.payload).toMatchObject({
      issueId: "issue-1",
      sourceRunId: "run-1",
      handoffRequired: true,
      handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      missingDisposition: "clear_next_step",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: "run-1",
      modelProfile: "cheap",
    });
    expect(decision.contextSnapshot).toMatchObject({
      wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
      handoffRequired: true,
      modelProfile: "cheap",
    });
    expect(decision.instruction).toContain("Resolve the missing disposition before creating or revising any new artifacts");
    expect(decision.instruction).toContain("Choose **exactly one** outcome");
    expect(decision.instruction).toContain("record an explicit continuation path");
  });

  it("does not queue when the issue already has a valid disposition", () => {
    expect(decide({ issue: { ...issue, status: "done" } as any })).toEqual({
      kind: "skip",
      reason: "issue status done is a valid disposition",
    });
  });

  it("does not queue when a successful run records an accepted next-action path", () => {
    expect(decide({ issue: { ...issue, status: "in_review" } as any })).toEqual({
      kind: "skip",
      reason: "issue status in_review is a valid disposition",
    });
    expect(decide({ issue: { ...issue, status: "blocked" } as any })).toEqual({
      kind: "skip",
      reason: "issue status blocked is a valid disposition",
    });
    expect(decide({ hasPendingInteractionOrApproval: true })).toEqual({
      kind: "skip",
      reason: "pending interaction or approval owns the next action",
    });
    expect(decide({ hasActiveExecutionPath: true })).toEqual({
      kind: "skip",
      reason: "issue already has an active execution path",
    });
  });

  it("does not queue when another wake or dependency path already owns the next action", () => {
    expect(decide({ hasQueuedWake: true })).toEqual({
      kind: "skip",
      reason: "issue already has a queued or deferred wake",
    });
    expect(decide({ hasExplicitBlockerPath: true })).toEqual({
      kind: "skip",
      reason: "explicit blocker path owns the next action",
    });
  });

  it("does not queue when a successful run has no progress signal", () => {
    expect(decide({ livenessState: null, detectedProgressSummary: null })).toEqual({
      kind: "skip",
      reason: "successful run did not produce handoff-relevant progress",
    });
  });

  it("does not treat adapter or runtime failures as missing-disposition handoffs", () => {
    expect(decide({ run: { ...run, status: "failed", errorCode: "adapter_failed" } as any })).toEqual({
      kind: "skip",
      reason: "source run did not succeed",
    });
  });

  it("does not queue on missing-comment retry bookkeeping runs", () => {
    expect(decide({ run: { ...run, issueCommentStatus: "retry_exhausted" } as any })).toEqual({
      kind: "skip",
      reason: "missing issue comment retry owns the next action",
    });
  });

  it("does not loop from a corrective handoff run", () => {
    expect(decide({
      run: {
        ...run,
        id: "run-2",
        contextSnapshot: {
          issueId: "issue-1",
          wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
          handoffRequired: true,
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "source run is already a corrective handoff run",
    });
  });

  it("does not queue for issue monitor maintenance runs", () => {
    expect(decide({
      run: {
        ...run,
        contextSnapshot: {
          issueId: "issue-1",
          source: "issue.monitor",
          wakeReason: "issue_monitor_due",
        },
      } as any,
    })).toEqual({
      kind: "skip",
      reason: "issue monitor run owns its own recovery path",
    });
  });

  it("uses a stable one-attempt idempotency key", () => {
    expect(buildFinishSuccessfulRunHandoffIdempotencyKey({
      issueId: "issue-1",
      sourceRunId: "run-1",
    })).toBe("finish_successful_run_handoff:issue-1:run-1:1");
  });

  it("allows failed or cancelled corrective wakes to be retried", () => {
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("queued")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("claimed")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("completed")).toBe(true);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("failed")).toBe(false);
    expect(isIdempotentFinishSuccessfulRunHandoffWakeStatus("cancelled")).toBe(false);
  });

  it("builds the required system notice with hidden structured metadata", () => {
    const notice = buildSuccessfulRunHandoffRequiredNotice({
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Finish backend handoff",
        status: "in_progress",
      } as any,
      run: {
        id: "22222222-2222-4222-8222-222222222222",
        status: "succeeded",
      } as any,
      agent: {
        id: "33333333-3333-4333-8333-333333333333",
        name: "CodexCoder",
      } as any,
      detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    });

    expect(notice.body).toBe(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(notice.presentation).toEqual({
      kind: "system_notice",
      tone: "warning",
      title: "Missing issue disposition",
      detailsDefaultOpen: false,
    });
    expect(notice.metadata.sourceRunId).toBe("22222222-2222-4222-8222-222222222222");
    expect(notice.metadata.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Required action",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "issue_link", identifier: "PAP-1" }),
          expect.objectContaining({ type: "agent_link", name: "CodexCoder" }),
          expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
        ]),
      }),
      expect.objectContaining({
        title: "Run evidence",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "run_link", runId: "22222222-2222-4222-8222-222222222222" }),
          expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          expect.objectContaining({ type: "key_value", label: "Detected progress" }),
        ]),
      }),
    ]));
  });

  it("builds the exhausted system notice with recovery metadata", () => {
    const notice = buildSuccessfulRunHandoffExhaustedNotice({
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Finish backend handoff",
        status: "in_progress",
      } as any,
      sourceRun: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" } as any,
      correctiveRun: { id: "44444444-4444-4444-8444-444444444444", status: "failed" } as any,
      sourceAssignee: { id: "33333333-3333-4333-8333-333333333333", name: "CodexCoder" } as any,
      recoveryIssue: {
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-2",
        title: "Recover missing next step PAP-1",
        status: "todo",
      } as any,
      recoveryActionId: "77777777-7777-4777-8777-777777777777",
      recoveryOwner: { id: "66666666-6666-4666-8666-666666666666", name: "CTO" } as any,
      latestIssueStatus: "in_progress",
      latestHandoffRunStatus: "failed",
      missingDisposition: "clear_next_step",
    });

    expect(notice.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(notice.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(notice.metadata.sourceRunId).toBe("22222222-2222-4222-8222-222222222222");
    expect(notice.metadata.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Recovery owner",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "key_value", label: "Recovery action", value: "77777777-7777-4777-8777-777777777777" }),
          expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CTO" }),
        ]),
      }),
      expect.objectContaining({
        title: "Run evidence",
        rows: expect.arrayContaining([
          expect.objectContaining({ type: "run_link", label: "Source run" }),
          expect.objectContaining({ type: "run_link", label: "Corrective handoff run" }),
          expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
        ]),
      }),
    ]));
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, "77777777-7777-4777-8777-777777777777")).toBe(true);
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, "88888888-8888-4888-8888-888888888888")).toBe(false);
  });

  it("recognizes new notices and legacy markdown headings for fallback deduplication", () => {
    expect(isSuccessfulRunHandoffRequiredNoticeBody(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("## Successful run missing issue disposition\n\nold body")).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("## This issue still needs a next step\n\nold body")).toBe(true);
    expect(isSuccessfulRunHandoffRequiredNoticeBody("Unrelated comment")).toBe(false);
  });
});
