import { describe, expect, it } from "vitest";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  isIssueAssignedToCurrentActor,
  isIssueAssignedToCurrentUser,
  parseAssigneeValue,
  suggestedCommentAssigneeValue,
} from "./assignees";

describe("assignee selection helpers", () => {
  it("encodes and parses agent assignees", () => {
    const value = assigneeValueFromSelection({ assigneeAgentId: "agent-123" });

    expect(value).toBe("agent:agent-123");
    expect(parseAssigneeValue(value)).toEqual({
      assigneeAgentId: "agent-123",
      assigneeUserId: null,
    });
  });

  it("encodes and parses current-user assignees", () => {
    const [option] = currentUserAssigneeOption("local-board");

    expect(option).toEqual({
      id: "user:local-board",
      label: "Me",
      searchText: "me board human local-board",
    });
    expect(parseAssigneeValue(option.id)).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
  });

  it("treats an empty selection as no assignee", () => {
    expect(parseAssigneeValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps backward compatibility for raw agent ids in saved drafts", () => {
    expect(parseAssigneeValue("legacy-agent-id")).toEqual({
      assigneeAgentId: "legacy-agent-id",
      assigneeUserId: null,
    });
  });

  it("formats current and board user labels consistently", () => {
    expect(formatAssigneeUserLabel("user-1", "user-1")).toBe("You");
    expect(formatAssigneeUserLabel("local-board", "someone-else")).toBe("Board");
    expect(formatAssigneeUserLabel("user-abcdef", "someone-else")).toBe("user-");
  });

  it("detects tasks assigned to the current board user", () => {
    expect(isIssueAssignedToCurrentUser({ assigneeUserId: "board-user" }, "board-user")).toBe(true);
    expect(isIssueAssignedToCurrentUser({ assigneeUserId: "other-user" }, "board-user")).toBe(false);
    expect(isIssueAssignedToCurrentUser({ assigneeUserId: null }, "board-user")).toBe(false);
    expect(isIssueAssignedToCurrentUser({ assigneeUserId: "board-user" }, null)).toBe(false);
  });

  it("detects tasks assigned to the visible Paperclip actor", () => {
    expect(
      isIssueAssignedToCurrentActor(
        { assigneeAgentId: "agent-steward", assigneeUserId: null },
        { currentUserId: "board-user", currentAgentIds: ["agent-steward"] },
      ),
    ).toBe(true);
    expect(
      isIssueAssignedToCurrentActor(
        { assigneeAgentId: "agent-other", assigneeUserId: null },
        { currentUserId: "board-user", currentAgentIds: ["agent-steward"] },
      ),
    ).toBe(false);
    expect(
      isIssueAssignedToCurrentActor(
        { assigneeAgentId: null, assigneeUserId: "board-user" },
        { currentUserId: "board-user", currentAgentIds: ["agent-steward"] },
      ),
    ).toBe(true);
  });

  it("suggests the last non-me commenter without changing the actual assignee encoding", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-123" },
        ],
        "board-user",
      ),
    ).toBe("agent:agent-123");
  });

  it("falls back to the actual assignee when there is no better commenter hint", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [{ authorUserId: "board-user" }],
        "board-user",
      ),
    ).toBe("user:board-user");
  });

  it("skips the current agent when choosing a suggested commenter assignee", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-self" },
          { authorAgentId: "agent-123" },
        ],
        null,
        "agent-self",
      ),
    ).toBe("agent:agent-123");
  });
});
