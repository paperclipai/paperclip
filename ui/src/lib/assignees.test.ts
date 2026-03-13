import { describe, expect, it } from "vitest";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  parseAssigneeValue,
} from "./assignees";

describe("assignees helpers", () => {
  it("serializes agent, user, and empty assignee selections", () => {
    expect(assigneeValueFromSelection({ assigneeAgentId: "agent-123" })).toBe("agent:agent-123");
    expect(assigneeValueFromSelection({ assigneeUserId: "user-123" })).toBe("user:user-123");
    expect(assigneeValueFromSelection({})).toBe("");
  });

  it("parses prefixed and legacy assignee values", () => {
    expect(parseAssigneeValue("agent:agent-123")).toEqual({
      assigneeAgentId: "agent-123",
      assigneeUserId: null,
    });
    expect(parseAssigneeValue("user:user-123")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "user-123",
    });
    expect(parseAssigneeValue("legacy-agent-id")).toEqual({
      assigneeAgentId: "legacy-agent-id",
      assigneeUserId: null,
    });
    expect(parseAssigneeValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("creates a current-user shortcut option only when a user id exists", () => {
    expect(currentUserAssigneeOption(null)).toEqual([]);
    expect(currentUserAssigneeOption("local-board")).toEqual([
      {
        id: "user:local-board",
        label: "Me",
        searchText: "me board human local-board",
      },
    ]);
  });

  it("formats assignee user labels consistently", () => {
    expect(formatAssigneeUserLabel("user-123", "user-123")).toBe("Me");
    expect(formatAssigneeUserLabel("local-board", "another-user")).toBe("Board");
    expect(formatAssigneeUserLabel("abcdef123456", "another-user")).toBe("abcde");
    expect(formatAssigneeUserLabel(null, "another-user")).toBeNull();
  });
});
