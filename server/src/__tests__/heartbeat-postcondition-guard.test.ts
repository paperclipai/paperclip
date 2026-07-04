import { describe, expect, it } from "vitest";
import {
  evaluateHeartbeatPostCondition,
  HEARTBEAT_POSTCONDITION_EVENT_TYPE,
  HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY,
  HEARTBEAT_POSTCONDITION_TERMINAL_STATUS,
  type HeartbeatPostConditionInput,
} from "../services/heartbeat-postcondition-guard.js";

function baseInput(overrides: Partial<HeartbeatPostConditionInput> = {}): HeartbeatPostConditionInput {
  return {
    issueOriginKind: "routine_execution",
    issueStatus: "in_progress",
    runOutcome: "succeeded",
    hasRunComment: false,
    hasRunChildIssue: false,
    ...overrides,
  };
}

describe("evaluateHeartbeatPostCondition — happy paths (guard NOT fired)", () => {
  it("does not fire when the issue is not a routine execution (manual issue)", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ issueOriginKind: "manual" }))).toEqual({
      triggered: false,
      reason: "not_routine_execution",
    });
  });

  it("does not fire when the origin kind is missing", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ issueOriginKind: null }))).toEqual({
      triggered: false,
      reason: "not_routine_execution",
    });
  });

  it("does not fire when the run outcome is failed (has its own retry path)", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ runOutcome: "failed" }))).toEqual({
      triggered: false,
      reason: "run_not_guarded_outcome",
    });
  });

  it("does not fire when the run outcome is timed_out", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ runOutcome: "timed_out" }))).toEqual({
      triggered: false,
      reason: "run_not_guarded_outcome",
    });
  });

  it("does not fire when the run outcome is cancelled (intentional abort)", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ runOutcome: "cancelled" }))).toEqual({
      triggered: false,
      reason: "run_not_guarded_outcome",
    });
  });

  it("does not fire when the issue was already PATCHed to done during the run", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ issueStatus: "done" }))).toEqual({
      triggered: false,
      reason: "issue_already_terminal",
    });
  });

  it("does not fire when the issue was PATCHed to blocked (agent named a blocker)", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ issueStatus: "blocked" }))).toEqual({
      triggered: false,
      reason: "issue_already_terminal",
    });
  });

  it("does not fire when the issue was handed off to in_review", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ issueStatus: "in_review" }))).toEqual({
      triggered: false,
      reason: "issue_already_terminal",
    });
  });

  it("does not fire when the run posted an issue comment (progress recorded)", () => {
    expect(evaluateHeartbeatPostCondition(baseInput({ hasRunComment: true }))).toEqual({
      triggered: false,
      reason: "run_recorded_progress",
    });
  });

  it("does not fire when the run created a child issue (legitimate handoff)", () => {
    // Backward-compat guarantee: routines that hand off via spawning a child
    // issue continue to work unchanged.
    expect(evaluateHeartbeatPostCondition(baseInput({ hasRunChildIssue: true }))).toEqual({
      triggered: false,
      reason: "run_recorded_progress",
    });
  });

  it("does not fire when the run posted both a comment and a child issue", () => {
    expect(
      evaluateHeartbeatPostCondition(
        baseInput({ hasRunComment: true, hasRunChildIssue: true }),
      ),
    ).toEqual({ triggered: false, reason: "run_recorded_progress" });
  });
});

describe("evaluateHeartbeatPostCondition — sad path (guard FIRES)", () => {
  it("fires on the canonical silent-exit case: routine + succeeded + in_progress + no comment + no child", () => {
    // The exact shape a scheduled routine takes when its agent thinks it
    // scheduled a wake but the wake API silently no-ops: adapter exits 0,
    // no PATCH, no comment, no child. Without a guard the issue would sit
    // at in_progress until an external productivity scanner picks it up.
    expect(evaluateHeartbeatPostCondition(baseInput())).toEqual({
      triggered: true,
      reason: "no_terminal_patch",
    });
  });
});

describe("guard constants — audit trail contract", () => {
  it("exports the distinct telemetry event name callers depend on", () => {
    // Downstream measurement queries reference this exact string —
    // pin it in a test so it does not silently drift.
    expect(HEARTBEAT_POSTCONDITION_EVENT_TYPE).toBe("heartbeat.postcondition.no_terminal_patch");
  });

  it("auto-transitions to `done` (chosen over `blocked`)", () => {
    // Rationale: routine fires re-fire on schedule, so `done` is the
    // correct terminal for a finished-with-no-progress fire — the next
    // scheduled fire will re-pick up whatever state exists. `blocked`
    // would require a named blocker owner that this guard has no way to
    // choose correctly.
    expect(HEARTBEAT_POSTCONDITION_TERMINAL_STATUS).toBe("done");
  });

  it("posts a system comment that explains what happened without any external link the operator cannot open", () => {
    expect(HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY).toContain("Auto-terminated");
    expect(HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY).toContain("no comment");
    expect(HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY).toContain("no child issue");
    // Explicitly does NOT hard-code a runbook link — the message must be
    // meaningful in every downstream Paperclip instance, not one specific
    // company's instance.
    expect(HEARTBEAT_POSTCONDITION_SYSTEM_COMMENT_BODY).not.toMatch(/https?:\/\//);
  });
});
