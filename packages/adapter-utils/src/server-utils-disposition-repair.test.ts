import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt, stringifyPaperclipWakePayload } from "./server-utils.js";

const ownerRepairWake = {
  reason: "issue_disposition_repair",
  issue: { id: "issue-example", title: "Finish the assigned task", status: "in_progress", description: "Write the requested complete answer." },
  recovery: {
    cause: "deliberate_wait_without_target",
    originalAssignee: { id: "agent-example", name: "Original owner" },
    attemptCount: 1,
    maxAttempts: 2,
    nextAction: "The original owner must record a supported task disposition.",
  },
  commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
  comments: [],
  fallbackFetchNeeded: false,
};

describe("original-owner recovery instructions", () => {
  it.each([false, true])("records disposition without telling the owner to hand back to itself (resumed: %s)", (resumedSession) => {
    const prompt = renderPaperclipWakePrompt(ownerRepairWake, { resumedSession, includeExecutionContract: true });
    expect(prompt).toContain("Disposition repair contract:");
    expect(prompt).toContain("Re-read the current task state.");
    expect(prompt).toContain("Use Paperclip tools/API to record completion, a real blocker, a question or approval request, or a supported next execution path.");
    expect(prompt).toContain("A final message alone does not record disposition.");
    expect(prompt).toContain("Respect Stop, pause, budget and approval gates.");
    expect(prompt).toContain("Do not start new deliverable work during this repair.");
    expect(prompt).not.toContain("hand it back");
    expect(prompt).not.toContain("send back to Original owner");
    expect(prompt).not.toContain("resolutionNote");
    expect(prompt).not.toContain("Any comment you post on the source issue must be ≤3 lines");
    expect(prompt).toContain("- recovery cause: deliberate_wait_without_target");
    expect(prompt).toContain("- recovery attempt: 1/2");
    expect(JSON.parse(stringifyPaperclipWakePayload(ownerRepairWake) ?? "{}")).toMatchObject({ recovery: ownerRepairWake.recovery });
  });

  for (const cause of ["deliberate_wait_without_target", "workspace_validation_failed"]) {
    it.each([false, true])(`resumes source work after restored ${cause} recovery (resumed: %s)`, (resumedSession) => {
      const wake = { ...ownerRepairWake, reason: "issue_recovery_action_restored", recovery: { ...ownerRepairWake.recovery, cause } };
      const prompt = renderPaperclipWakePrompt(wake, { resumedSession, includeExecutionContract: true });
      expect(prompt).toContain(resumedSession ? "continue the current task" : "Use this wake to continue the task");
      expect(prompt).toContain(wake.issue.description);
      expect(prompt).not.toContain("Recovery contract:");
      expect(prompt).not.toContain("Disposition repair contract:");
      expect(prompt).not.toContain("Do not produce the deliverable yourself");
      expect(prompt).not.toContain("resolutionNote");
      expect(prompt).not.toContain("- recovery attempt:");
      expect(JSON.parse(stringifyPaperclipWakePayload(wake) ?? "{}")).toMatchObject({ recovery: wake.recovery });
    });
  }

  it.each(["stranded_assigned_issue", "workspace_validation_failed", "provider_quota", "unknown_cause"])("preserves the separate-helper contract for active %s recovery", (cause) => {
    const prompt = renderPaperclipWakePrompt({ ...ownerRepairWake, reason: "source_scoped_recovery_action", recovery: { ...ownerRepairWake.recovery, cause } });
    expect(prompt).toContain("Recovery contract: your job is to RECOVER this task");
    expect(prompt).toContain("Fallback preference order: (1) send back to Original owner");
    expect(prompt).toContain("resolutionNote");
    expect(prompt).not.toContain("Disposition repair contract:");
  });
});
