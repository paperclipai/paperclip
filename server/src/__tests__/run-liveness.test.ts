import { describe, expect, it } from "vitest";
import { classifyRunLiveness } from "../services/run-liveness.ts";

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

  it("does not let a negation mask a required approval", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Not blocked, but I need board approval before deploying the change.",
      },
    });

    expect(classification.actionability).toBe("approval_required");
    expect(classification.livenessState).toBe("blocked");
  });

  it("does not let a negation mask a manager/escalation signal", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "No blockers remaining; escalate to security review before rotating the API secret.",
      },
    });

    expect(classification.actionability).toBe("manager_review");
    expect(classification.livenessState).toBe("needs_followup");
  });

  it("escalates a manager-review run to human review even with concrete evidence", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Finished the change and will escalate to security review before the production deploy.",
      },
      evidence: {
        issueCommentsCreated: 1,
        workProductsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    // Without the escalation gate this run's concrete evidence would classify it
    // as "advanced" and let it auto-continue.
    expect(classification.actionability).toBe("manager_review");
    expect(classification.livenessState).toBe("needs_followup");
  });

  it("still lets a negation relax a plain runnable follow-up", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "No blockers; run pnpm test to verify the change.",
      },
    });

    expect(classification.actionability).toBe("runnable");
  });

  describe("adversarial table-driven test matrix", () => {
    const testCases: Array<{
      name: string;
      summary: string;
      issueComment?: string[];
      evidence?: Record<string, unknown>;
      humanReviewRequired: boolean;
      expectedActionability: "approval_required" | "manager_review" | "blocked_external" | "runnable";
      expectedLiveness: "blocked" | "needs_followup";
    }> = [
      // === negation + approval_required ===
      {
        name: "negated blocker with explicit approval need",
        summary: "Not blocked, but I need board approval before deploying the change.",
        expectedActionability: "approval_required",
        expectedLiveness: "blocked",
        humanReviewRequired: true,
      },
      {
        name: "negated blocker with approval nested in mid-sentence",
        summary: "There's no blocker here; the only pending item is approval from the security team.",
        expectedActionability: "approval_required",
        expectedLiveness: "blocked",
        humanReviewRequired: true,
      },
      {
        name: "negation does NOT suppress a pending approval from issue comments",
        summary: "No blockers remaining.",
        issueComment: ["Pending approval from the board before we can proceed with deployment.", "Next action: deploy."],
        expectedActionability: "approval_required",
        expectedLiveness: "blocked",
        humanReviewRequired: true,
      },
      // === negation + manager_review ===
      {
        name: "negated blocker with manager review signal",
        summary: "No blockers left; escalate to security review before rotating the keys.",
        expectedActionability: "manager_review",
        expectedLiveness: "needs_followup",
        humanReviewRequired: true,
      },
      {
        name: "negation does NOT suppress a deploy-to-production signal",
        summary: "Not blocked; continuing to deploy to prod.",
        expectedActionability: "manager_review",
        expectedLiveness: "needs_followup",
        humanReviewRequired: true,
      },
      {
        name: "negation + manager review from issue comment",
        summary: "All clear with no issues.",
        issueComment: ["We need a production deploy after this pass.", "Next step: run integration tests."],
        expectedActionability: "manager_review",
        expectedLiveness: "needs_followup",
        humanReviewRequired: true,
      },
      // === manager_review + concrete evidence ===
      {
        name: "manager_review with concrete evidence still needs followup (not advanced)",
        summary: "Deploy to prod after verifying",
        evidence: {
          issueCommentsCreated: 2,
          workProductsCreated: 1,
          latestEvidenceAt: "2026-04-18T12:00:00Z",
        },
        expectedActionability: "manager_review",
        expectedLiveness: "needs_followup",
        humanReviewRequired: true,
      },
      // === negation + blocked_external ===
      {
        name: "negated external blocker becomes runnable",
        summary: "Not blocked; no more credentials needed.",
        expectedActionability: "unknown",
        expectedLiveness: "needs_followup",
        humanReviewRequired: false,
      },
      {
        name: "negated external blocker with future task stays runnable",
        summary: "No blockers; run npm test to verify.",
        expectedActionability: "runnable",
        expectedLiveness: "needs_followup",
        humanReviewRequired: false,
      },
      // === approval_required without negation ===
      {
        name: "plain approval request with no negation",
        summary: "I need approval before deploying this change.",
        expectedActionability: "approval_required",
        expectedLiveness: "blocked",
        humanReviewRequired: true,
      },
      // === manager_review without negation ===
      {
        name: "plain production deploy signal",
        summary: "Deploy to production and verify live traffic.",
        expectedActionability: "manager_review",
        expectedLiveness: "needs_followup",
        humanReviewRequired: true,
      },
      // === BOTH approval + manager_review signals ===
      {
        name: "both approval and manager review in same output (approval wins)",
        summary: "Not blocked, but I need board approval before the production deploy.",
        expectedActionability: "approval_required",
        expectedLiveness: "blocked",
        humanReviewRequired: true,
      },
      // === negation that mimics but does NOT match ===
      {
        name: "negation of unrelated text leaves blocked_external intact",
        summary: "Not blocked by the board, but I need API credentials to proceed.",
        expectedActionability: "blocked_external",
        expectedLiveness: "blocked",
        humanReviewRequired: false,
      },
      {
        name: "negation only affects the blocked part but actionability is runnable",
        summary: "Not blocked; run pnpm test to verify the change.",
        expectedActionability: "runnable",
        expectedLiveness: "needs_followup",
        humanReviewRequired: false,
      },
      {
        name: "no blocker declared plus vague next task isn't blocked or approval",
        summary: "Not blocked; next: follow the run instructions to validate.",
        expectedActionability: "runnable",
        expectedLiveness: "needs_followup",
        humanReviewRequired: false,
      },
    ];

    for (const tc of testCases) {
      it(tc.name, () => {
        const classification = classifyRunLiveness({
          ...baseInput,
          resultJson: {
            summary: tc.summary,
          },
          issueCommentBodies: tc.issueComment ? [tc.issueComment.join("\n")] : undefined,
          evidence: tc.evidence as Record<string, unknown> ? {
            ...tc.evidence,
          } : undefined,
        });

        expect(classification.actionability).toBe(tc.expectedActionability);
        expect(classification.livenessState).toBe(tc.expectedLiveness);

        if (tc.humanReviewRequired) {
          expect(classification.livenessState).not.toBe("advanced");
        }
      });
    }
  });

  // Lifecycle golden corpus: locks the run-status / issue-status / evidence axis
  // that the adversarial matrix (text-actionability only) does not cover, so every
  // RunLivenessState has a pinned case. A regression here flips a real run's fate.
  describe("lifecycle golden corpus", () => {
    const evidenceAt = new Date("2026-04-18T12:00:00Z");
    const lifecycleCases: Array<{
      name: string;
      input: Parameters<typeof classifyRunLiveness>[0];
      expectedLiveness: string;
    }> = [
      {
        name: "interrupted run -> needs_followup",
        input: { ...baseInput, runStatus: "interrupted", errorCode: "session_reset" },
        expectedLiveness: "needs_followup",
      },
      {
        name: "adapter-failed run -> failed",
        input: { ...baseInput, runStatus: "failed", errorCode: "adapter_failed" },
        expectedLiveness: "failed",
      },
      {
        name: "timed-out run -> failed",
        input: { ...baseInput, runStatus: "timeout" },
        expectedLiveness: "failed",
      },
      {
        name: "issue already done -> completed",
        input: { ...baseInput, issue: { ...baseInput.issue, status: "done" } },
        expectedLiveness: "completed",
      },
      {
        name: "issue cancelled -> completed",
        input: { ...baseInput, issue: { ...baseInput.issue, status: "cancelled" } },
        expectedLiveness: "completed",
      },
      {
        name: "succeeded with no output or evidence -> empty_response",
        input: { ...baseInput },
        expectedLiveness: "empty_response",
      },
      {
        name: "concrete action evidence -> advanced",
        input: {
          ...baseInput,
          resultJson: { summary: "Applied the change." },
          evidence: { issueCommentsCreated: 1, workProductsCreated: 1, latestEvidenceAt: evidenceAt },
        },
        expectedLiveness: "advanced",
      },
      {
        name: "plan-document revision with useful output -> advanced",
        input: {
          ...baseInput,
          resultJson: { summary: "Drafted the implementation plan." },
          evidence: { planDocumentRevisionsCreated: 1, latestEvidenceAt: evidenceAt },
        },
        expectedLiveness: "advanced",
      },
      {
        name: "useful completed output, no concrete evidence -> needs_followup",
        input: { ...baseInput, resultJson: { summary: "Corrected the typo in the configuration comment." } },
        expectedLiveness: "needs_followup",
      },
    ];

    for (const tc of lifecycleCases) {
      it(tc.name, () => {
        expect(classifyRunLiveness(tc.input).livenessState).toBe(tc.expectedLiveness);
      });
    }
  });
});
