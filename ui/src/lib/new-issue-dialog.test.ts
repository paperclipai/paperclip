import { describe, expect, it } from "vitest";
import {
  nextAssigneeConfirmTarget,
  nextTitleTabTarget,
  resolveDraftAssigneeValue,
} from "./new-issue-dialog";

describe("new issue dialog helpers", () => {
  it("prefers explicit defaults over saved draft assignee values", () => {
    expect(
      resolveDraftAssigneeValue(
        { assigneeAgentId: "agent-123" },
        { assigneeValue: "user:user-456" },
      ),
    ).toBe("agent:agent-123");

    expect(
      resolveDraftAssigneeValue(
        { assigneeUserId: "user-123" },
        { assigneeValue: "agent:agent-456" },
      ),
    ).toBe("user:user-123");
  });

  it("restores modern and legacy draft assignee values when defaults are empty", () => {
    expect(resolveDraftAssigneeValue({}, { assigneeValue: "user:user-123" })).toBe("user:user-123");
    expect(resolveDraftAssigneeValue({}, { assigneeId: "legacy-agent-id" })).toBe("legacy-agent-id");
    expect(resolveDraftAssigneeValue({}, null)).toBe("");
  });

  it("advances title tab focus to the next empty field", () => {
    expect(nextTitleTabTarget({ assigneeValue: "", projectId: "" })).toBe("assignee");
    expect(nextTitleTabTarget({ assigneeValue: "user:user-123", projectId: "" })).toBe("project");
    expect(nextTitleTabTarget({ assigneeValue: "user:user-123", projectId: "project-123" })).toBe("description");
  });

  it("jumps from assignee confirm to project or description", () => {
    expect(nextAssigneeConfirmTarget("")).toBe("project");
    expect(nextAssigneeConfirmTarget("project-123")).toBe("description");
  });
});
