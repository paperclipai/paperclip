import { describe, expect, it } from "vitest";
import {
  classifyWakeReasonFromContext,
  isRoutineTerminalSyntheticContinuationWake,
  resumeIntentFromIssueWakeContext,
} from "./routine-terminal-continuation.js";

describe("routine-terminal-continuation helpers", () => {
  it("resumeIntentFromIssueWakeContext honors structured resume / resumeIntent flags", () => {
    expect(resumeIntentFromIssueWakeContext({ resume: true })).toBe(true);
    expect(resumeIntentFromIssueWakeContext({ resumeIntent: true })).toBe(true);
    expect(resumeIntentFromIssueWakeContext({ followUpRequested: true })).toBe(true);
    expect(resumeIntentFromIssueWakeContext({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("classifyWakeReasonFromContext prefers wakeReason then reason", () => {
    expect(classifyWakeReasonFromContext({ wakeReason: "issue_children_completed", reason: "ignored" })).toBe(
      "issue_children_completed",
    );
    expect(classifyWakeReasonFromContext({ reason: "issue_continuation_needed" })).toBe("issue_continuation_needed");
  });

  it("isRoutineTerminalSyntheticContinuationWake enumerates continuation envelope reasons", () => {
    expect(isRoutineTerminalSyntheticContinuationWake("issue_children_completed")).toBe(true);
    expect(isRoutineTerminalSyntheticContinuationWake("issue_reopened_via_comment")).toBe(true);
    expect(isRoutineTerminalSyntheticContinuationWake("issue_continuation_needed")).toBe(true);
    expect(isRoutineTerminalSyntheticContinuationWake("issue_assigned")).toBe(false);
  });
});
