import { describe, expect, it } from "vitest";
import { normalizeExclusiveAssigneePatch } from "../services/issue-assignee-patch.js";

describe("normalizeExclusiveAssigneePatch", () => {
  it("clears a user assignee when an agent-only handoff is requested", () => {
    expect(normalizeExclusiveAssigneePatch({ assigneeAgentId: "agent-1" })).toEqual({
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
  });

  it("clears an agent assignee when a user-only handoff is requested", () => {
    expect(normalizeExclusiveAssigneePatch({ assigneeUserId: "user-1" })).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    });
  });

  it("preserves explicit dual-field payloads for downstream validation", () => {
    expect(
      normalizeExclusiveAssigneePatch({
        assigneeAgentId: "agent-1",
        assigneeUserId: "user-1",
      }),
    ).toEqual({
      assigneeAgentId: "agent-1",
      assigneeUserId: "user-1",
    });
  });
});
