import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatSchedulingSuppression,
  resolveSkillTestRunCompletionForHeartbeatOutcome,
} from "../services/heartbeat.ts";

describe("heartbeat scheduling suppression", () => {
  it("suppresses heartbeat scheduling for worktree runtimes", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_IN_WORKTREE: "true",
    })).toEqual({
      suppressed: true,
      reason: "worktree_instance",
    });
  });

  it("suppresses heartbeat scheduling while database restore is in progress", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1",
    })).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });

  it("leaves normal live-plane runtimes unsuppressed", () => {
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("lifts worktree suppression when run execution is explicitly allowed", () => {
    expect(
      resolveHeartbeatSchedulingSuppression(
        { PAPERCLIP_IN_WORKTREE: "true" },
        { allowWorktreeRunExecution: true },
      ),
    ).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("still suppresses database restore even when worktree run execution is allowed", () => {
    expect(
      resolveHeartbeatSchedulingSuppression(
        {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1",
        },
        { allowWorktreeRunExecution: true },
      ),
    ).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });

  it("maps unsuccessful heartbeat outcomes to terminal skill test run outcomes", () => {
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("succeeded", null)).toBeNull();
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("cancelled", null)).toEqual({
      outcome: "cancelled",
      error: "Harness run was cancelled",
      heartbeatOutcome: "cancelled",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("timed_out", null)).toEqual({
      outcome: "failed",
      error: "Timed out",
      heartbeatOutcome: "timed_out",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("failed", "Adapter crashed")).toEqual({
      outcome: "failed",
      error: "Adapter crashed",
      heartbeatOutcome: "failed",
    });
  });
});
