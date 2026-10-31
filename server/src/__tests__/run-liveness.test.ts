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

  it("uses explicit planning mode for the planning diagnostic exemption", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        status: "in_progress",
        title: "Draft implementation plan",
        description: "Create a plan for the work.",
        workMode: "planning",
      },
      resultJson: {
        summary: "Plan:\n- Inspect files\n- Implement after approval",
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it.each([undefined, null, "standard", "ask", "skill_test", "planning"])(
    "title and description cannot change liveness in explicit mode %s",
    (workMode) => {
      const input = {
        ...baseInput,
        issue: { ...baseInput.issue, workMode },
        resultJson: { summary: "I will inspect the repo next." },
      };
      const expected = classifyRunLiveness(input);
      expect(expected.livenessState).toBe(workMode === "planning" ? "advanced" : "plan_only");
      for (const text of ["plan", "planning", "analysis", "investigation", "research", "report", "proposal", "design doc", "write-up", "making a plan", "No plan requested", "Preparar un plan"]) {
        for (const prose of [{ title: `Implement ${text} export` }, { description: `Create a ${text} exporter.` }]) {
          expect(classifyRunLiveness({ ...input, issue: { ...input.issue, ...prose } })).toEqual(expected);
        }
      }
    },
  );

  it("a standard-mode task can deliver a plan and complete without entering planning mode", () => {
    const input = {
      ...baseInput,
      issue: { ...baseInput.issue, workMode: "standard", title: "Write a plan" },
      resultJson: { summary: "Plan:\n1. Inspect files.\n2. Implement the service." },
      evidence: { documentRevisionsCreated: 1, planDocumentRevisionsCreated: 1 },
    };
    expect(classifyRunLiveness(input).livenessState).toBe("advanced");
    expect(classifyRunLiveness({ ...input, issue: { ...input.issue, status: "done" } }).livenessState).toBe("completed");
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

describe("truncated final turn (model output limit) liveness", () => {
  // The adapter maps a length-stopped terminal turn with no completion text
  // to a failed run (exit 1, typed error code) and records the
  // machine-readable marker in resultJson. These shapes are what the
  // classifier actually sees for the truncation edge.
  const marker = { finalStopReason: "length", finalMessageEmpty: true } as Record<string, unknown>;

  it("treats a failed run cut off at the output limit as an actionable empty response", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      error: "Pi stopped at the model output limit before completing its final turn",
      errorCode: "pi_completion_truncated",
      resultJson: {
        ...marker,
        // The raw transcript is present, so transcript heuristics see a
        // "useful" run; only the machine-readable marker reveals the
        // truncation edge.
        stdoutExcerpt: "line1\nline2",
        summary: "",
      },
    });

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.livenessReason).toMatch(/output limit/i);
    // The truncation marker drives an explicit actionable next action; the
    // bounded continuation gate acts on the liveness state, not on the
    // (noise-derived) actionability of the raw transcript.
    expect(classification.nextAction).toMatch(/fresh run/i);
    expect(classification.lastUsefulActionAt).toBeNull();
  });

  it("continues a failed truncated run that left no durable progress even when the transcript looks busy", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      error: "Pi stopped at the model output limit before completing its final turn",
      errorCode: "pi_completion_truncated",
      resultJson: {
        ...marker,
        stdoutExcerpt: "tool result lines and a partial summary that was cut off mid-sentence",
        summary: "Partial summary that was cut off",
      },
      evidence: null,
    });

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.livenessReason).toMatch(/output limit/i);
  });

  it("keeps unrelated failed runs terminal (no truncation marker)", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      error: "process lost",
      errorCode: "process_lost",
      resultJson: null,
    });

    expect(classification.livenessState).toBe("failed");
  });

  it("keeps a failed run terminal when the length marker was written for a turn that delivered text", () => {
    // The adapter records the marker for any length-stopped terminal turn and
    // keeps it when the run fails for an unrelated reason. Only the
    // empty-completion edge may trigger the continuation.
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      error: "provider returned an error mid-run",
      errorCode: "provider_error",
      resultJson: {
        finalStopReason: "length",
        finalMessageEmpty: false,
        summary: "Partial answer that was cut mid-sentence",
      },
    });

    expect(classification.livenessState).toBe("failed");
    expect(classification.livenessReason).not.toMatch(/output limit/i);
  });

  it("keeps a succeeded run that delivered completion text plus durable progress advanced", () => {
    const latestEvidenceAt = new Date("2026-10-09T12:00:00Z");
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        finalStopReason: "length",
        finalMessageEmpty: false,
        summary: "I committed the change and pushed the branch.",
      },
      evidence: {
        issueCommentsCreated: 1,
        latestEvidenceAt,
      },
    });

    expect(classification.livenessState).toBe("advanced");
    expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
  });

  it("wakes a succeeded run cut off at the output limit with no completion text", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: { ...marker },
    });

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.livenessReason).toMatch(/output limit/i);
  });
});
