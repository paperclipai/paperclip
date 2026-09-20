import { describe, expect, it } from "vitest";
import {
  BLOCKED_WITHOUT_WAKE_PATH_ACTION,
  resolveAutoBlockedUnblockDescriptor,
} from "./blocked-wake-path.js";

describe("resolveAutoBlockedUnblockDescriptor", () => {
  it("returns null when unresolved blockers already provide the wake path", () => {
    expect(resolveAutoBlockedUnblockDescriptor({
      blockerIssueIds: ["blocker-1"],
      ownerAgentId: null,
    })).toBeNull();
  });

  it("names the board as the unblock owner when nothing else wakes the issue", () => {
    expect(resolveAutoBlockedUnblockDescriptor({
      blockerIssueIds: [],
      ownerAgentId: null,
    })).toEqual({ owner: "board", action: BLOCKED_WITHOUT_WAKE_PATH_ACTION });
  });

  it("names a recovery owner agent when one is known", () => {
    expect(resolveAutoBlockedUnblockDescriptor({
      blockerIssueIds: [],
      ownerAgentId: "agent-1",
      action: "Restore a live execution path.",
    })).toEqual({ owner: { agentId: "agent-1" }, action: "Restore a live execution path." });
  });

  it("falls back to the default action when the supplied action is blank", () => {
    expect(resolveAutoBlockedUnblockDescriptor({
      blockerIssueIds: [],
      ownerAgentId: null,
      action: "   ",
    })).toEqual({ owner: "board", action: BLOCKED_WITHOUT_WAKE_PATH_ACTION });
  });
});
