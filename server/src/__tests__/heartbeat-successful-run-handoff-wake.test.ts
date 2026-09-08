import { describe, expect, it } from "vitest";
import {
  isPaperclipRecoveryWakePayload,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { decideIssueReviewPathRecovery } from "../services/recovery/review-path-recovery.js";
import {
  SUCCESSFUL_RUN_HANDOFF_OPTIONS,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  decideSuccessfulRunHandoff,
} from "../services/recovery/successful-run-handoff.js";

// buildPaperclipWakePayload only reads the run-secret registry through the
// injected db, so a stub that returns no rows keeps this suite off Postgres.
const db = {
  select: () => ({
    from: () => ({
      where: async () => [],
    }),
  }),
} as never;

const issueSummary = {
  id: "issue-1",
  identifier: "PAP-1",
  title: "Finish backend handoff",
  description: "Implement and verify the backend handoff behavior.",
  status: "in_progress",
  priority: "medium",
  workMode: "standard",
};

function handoffContextSnapshot() {
  const decision = decideSuccessfulRunHandoff({
    run: {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
      contextSnapshot: { issueId: "issue-1" },
    } as never,
    issue: {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-1",
      title: "Finish backend handoff",
      description: "Implement and verify the backend handoff behavior.",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      executionState: null,
    } as never,
    agent: { id: "agent-1", companyId: "company-1", status: "idle" } as never,
    livenessState: "advanced",
    detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    finalReport: "Implemented the handoff path and ran the focused test.",
    nextAction: "Record the correct issue disposition.",
    taskKey: "issue-1",
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
  if (decision.kind !== "enqueue") throw new Error(`expected an enqueue decision, got ${decision.kind}`);
  return decision.contextSnapshot;
}

function reviewPathContextSnapshot() {
  const decision = decideIssueReviewPathRecovery({
    issueId: "issue-1",
    sourceRunId: "run-1",
    assigneeAgentId: "agent-1",
    contextSnapshot: { issueId: "issue-1", wakeReason: "issue_assigned" },
    reviewAttention: { state: "stalled", paths: [], reason: null },
    existingWake: false,
  });
  if (decision.kind !== "enqueue") throw new Error(`expected an enqueue decision, got ${decision.kind}`);
  return decision.contextSnapshot;
}

describe("successful-run handoff wake payload", () => {
  it("carries the producer's remediation instruction into the payload and the prompt", async () => {
    const payload = await buildPaperclipWakePayload({
      db,
      companyId: "company-1",
      contextSnapshot: handoffContextSnapshot(),
      issueSummary,
    });

    expect(payload?.successfulRunHandoff).toMatchObject({
      attempt: 1,
      maxAttempts: 1,
      sourceRunId: "run-1",
      reason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      missingDisposition: "clear_next_step",
      validDispositionOptions: [...SUCCESSFUL_RUN_HANDOFF_OPTIONS],
    });

    const prompt = renderPaperclipWakePrompt(payload, { resumedSession: true });
    expect(prompt).toContain("Successful run missing a disposition:");
    expect(prompt).toContain(`- reason: ${SUCCESSFUL_RUN_MISSING_STATE_REASON}`);
    expect(prompt).toContain("- missing: clear_next_step");
    expect(prompt).toContain("Your last run on this issue ended successfully");
    expect(isPaperclipRecoveryWakePayload(payload)).toBe(true);
  });

  it("does not read a review-path recovery wake as a successful-run handoff", async () => {
    // Review-path recovery writes a bare `instruction` and `sourceRunId` into its
    // context snapshot. Only `handoffRequired` and `handoffReason` mark a
    // successful-run handoff, so this wake must keep its own shape.
    const contextSnapshot = reviewPathContextSnapshot();
    expect(contextSnapshot).toMatchObject({
      instruction: expect.stringContaining("still in review"),
      sourceRunId: "run-1",
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId: "company-1",
      contextSnapshot,
      issueSummary,
    });

    expect(payload?.successfulRunHandoff ?? null).toBeNull();
    expect(renderPaperclipWakePrompt(payload, { resumedSession: true }))
      .not.toContain("Successful run missing a disposition");
    expect(isPaperclipRecoveryWakePayload(payload)).toBe(false);
  });
});
