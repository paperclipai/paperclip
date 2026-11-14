import { describe, expect, it } from "vitest";
import {
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

const dispositionRepairWake = {
  reason: "issue_disposition_repair_retry",
  issue: {
    id: "issue-example",
    title: "Finish the assigned task",
    status: "in_progress",
  },
  recovery: {
    cause: "deliberate_wait_without_target",
    originalAssignee: { id: "agent-example", name: "Original owner" },
    attemptCount: 1,
    maxAttempts: 2,
    nextAction:
      "The original owner must replace the parked summary with a terminal, live, blocked, monitored, or typed waiting disposition.",
  },
  commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
  comments: [],
  fallbackFetchNeeded: false,
};

describe("owner disposition repair wake contract", () => {
  it.each([false, true])(
    "repairs disposition without handing back to self (resumed: %s)",
    (resumedSession) => {
      const prompt = renderPaperclipWakePrompt(dispositionRepairWake, {
        resumedSession,
      });

      expect(prompt).toContain("Disposition repair contract:");
      expect(prompt).toContain("Re-read the current task state.");
      expect(prompt).toContain(
        "Use Paperclip tools/API to record completion, a real blocker, a question or approval request, or a supported next execution path.",
      );
      expect(prompt).toContain(
        "A final message alone does not record disposition.",
      );
      expect(prompt).toContain(
        "Do not start new deliverable work during this repair.",
      );
      expect(prompt).toContain(
        "Respect Stop, pause, budget and approval gates.",
      );
      expect(prompt).not.toContain("You DO NOT do the work");
      expect(prompt).not.toContain("hand it back");
      expect(prompt).not.toContain("send back to Original owner");
      expect(prompt).not.toContain("resolutionNote");
      expect(prompt).not.toContain(
        "Any comment you post on the source issue must be ≤3 lines",
      );
      expect(prompt).toContain(
        "- recovery cause: deliberate_wait_without_target",
      );
      expect(prompt).toContain("- original assignee: Original owner");
      expect(prompt).toContain("- recovery attempt: 1/2");
      expect(prompt).toContain(
        `- next action: ${dispositionRepairWake.recovery.nextAction}`,
      );
      expect(
        JSON.parse(
          stringifyPaperclipWakePayload(dispositionRepairWake) ?? "{}",
        ),
      ).toMatchObject({
        recovery: dispositionRepairWake.recovery,
      });
    },
  );

  it.each([
    "stranded_assigned_issue",
    "workspace_validation_failed",
    "unknown_cause",
    null,
  ])("keeps the helper recovery contract for %s", (cause) => {
    const prompt = renderPaperclipWakePrompt({
      ...dispositionRepairWake,
      reason: "source_scoped_recovery_action",
      recovery: { ...dispositionRepairWake.recovery, cause },
    });

    expect(prompt).toContain(
      "Recovery contract: your job is to RECOVER this task, not to do the work.",
    );
    expect(prompt).toContain(
      `Fallback preference order: (1) send back to ${cause ? "Original owner" : "the original assignee"}`,
    );
    expect(prompt).toContain("resolutionNote");
    expect(prompt).not.toContain("Disposition repair contract:");
  });
});
