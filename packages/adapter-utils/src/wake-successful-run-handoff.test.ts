import { describe, expect, it } from "vitest";
import {
  isPaperclipRecoveryWakePayload,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
} from "./server-utils.js";

// A corrective "your run succeeded but the issue has no disposition" wake carries
// its remediation text in the handoff block. Before this block existed on the
// payload, the retry prompt said nothing about recording a disposition, so the
// corrective run repeated the previous run instead of closing it out.
const HANDOFF_WAKE = {
  reason: "finish_successful_run_handoff",
  issue: {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "PAP-123",
    title: "Answer a question",
    status: "in_progress",
    priority: "medium",
    workMode: "standard",
  },
  successfulRunHandoff: {
    attempt: 1,
    maxAttempts: 1,
    sourceRunId: "22222222-2222-4222-8222-222222222222",
    reason: "successful_run_missing_state",
    missingDisposition: "clear_next_step",
    validDispositionOptions: ["done", "blocked", "in_review"],
    instruction:
      "This is a status-only retry to the original agent. Record a disposition; do not start new work.",
  },
};

describe("successful-run handoff wake", () => {
  it("renders the remediation instruction", () => {
    const prompt = renderPaperclipWakePrompt(HANDOFF_WAKE);

    expect(prompt).toContain("Successful run missing a disposition:");
    expect(prompt).toContain("Record a disposition; do not start new work.");
  });

  it("names the reason, the missing value, the valid options and the attempt", () => {
    const prompt = renderPaperclipWakePrompt(HANDOFF_WAKE);

    expect(prompt).toContain("- reason: successful_run_missing_state");
    expect(prompt).toContain("- missing: clear_next_step");
    expect(prompt).toContain("- valid dispositions: done, blocked, in_review");
    expect(prompt).toContain("- attempt: 1/1");
  });

  it("counts as a recovery-scoped wake (full task brief on resume; recovery-style prompt selection in adapters)", () => {
    // The classification does two things: adapters that ask for the task brief on
    // a resumed session get the full brief instead of the compact delta, and the
    // adapters that skip their heartbeat prompt template on recovery wakes skip it
    // here too. It does not change the execution-contract lines that
    // renderPaperclipWakePrompt selects; those follow the local recovery block.
    expect(isPaperclipRecoveryWakePayload(HANDOFF_WAKE)).toBe(true);
    expect(
      selectPaperclipTaskMarkdown(
        {
          paperclipTaskMarkdown: "Full task brief.",
          paperclipTaskMarkdownCompact: "Compact resume delta.",
          paperclipWake: HANDOFF_WAKE,
        },
        { resumedSession: true },
      ),
    ).toBe("Full task brief.");
  });

  it("leaves an ordinary wake untouched", () => {
    const ordinary = { reason: "issue_assigned", issue: HANDOFF_WAKE.issue };

    expect(isPaperclipRecoveryWakePayload(ordinary)).toBe(false);
    expect(renderPaperclipWakePrompt(ordinary)).not.toContain("Successful run missing a disposition");
  });

  it("ignores a handoff block with nothing in it", () => {
    const empty = { ...HANDOFF_WAKE, successfulRunHandoff: {} };

    expect(isPaperclipRecoveryWakePayload(empty)).toBe(false);
    expect(renderPaperclipWakePrompt(empty)).not.toContain("Successful run missing a disposition");
  });
});
