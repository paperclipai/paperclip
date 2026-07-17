import { describe, expect, it } from "vitest";
import { resolveHeartbeatSchedulingSuppression } from "../services/heartbeat.ts";

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
});
