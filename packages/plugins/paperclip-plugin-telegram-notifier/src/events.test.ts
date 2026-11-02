import { describe, expect, it } from "vitest";
import { agentAssigneeChange } from "./events.js";

describe("agentAssigneeChange", () => {
  it("returns the new agent id from a top-level assigneeAgentId", () => {
    expect(agentAssigneeChange({ assigneeAgentId: "agent-1", identifier: "PAP-1" })).toBe(
      "agent-1",
    );
  });

  it("returns null when assignment was not part of the update", () => {
    // status-only update — no assigneeAgentId key on the payload.
    expect(agentAssigneeChange({ status: "in_progress", identifier: "PAP-1" })).toBeNull();
  });

  it("returns null on unassignment (assigneeAgentId === null)", () => {
    expect(agentAssigneeChange({ assigneeAgentId: null })).toBeNull();
  });

  it("skips no-op re-assignments when _previous matches", () => {
    expect(
      agentAssigneeChange({
        assigneeAgentId: "agent-1",
        _previous: { assigneeAgentId: "agent-1" },
      }),
    ).toBeNull();
  });

  it("fires when _previous shows a different (or empty) prior assignee", () => {
    expect(
      agentAssigneeChange({
        assigneeAgentId: "agent-2",
        _previous: { assigneeAgentId: "agent-1" },
      }),
    ).toBe("agent-2");
    expect(
      agentAssigneeChange({
        assigneeAgentId: "agent-2",
        _previous: { assigneeAgentId: null },
      }),
    ).toBe("agent-2");
  });

  it("regression: the old `changes.assigneeUserId` shape yields nothing", () => {
    // This is the payload shape the original handler assumed; it never carries
    // a top-level assigneeAgentId, so the notification correctly does not fire
    // off it — proving the bug was reading the wrong key, not missing data.
    expect(
      agentAssigneeChange({ changes: { assigneeUserId: { to: "user-1" } } }),
    ).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(agentAssigneeChange(undefined)).toBeNull();
    expect(agentAssigneeChange("nope")).toBeNull();
    expect(agentAssigneeChange(["a"])).toBeNull();
  });
});
