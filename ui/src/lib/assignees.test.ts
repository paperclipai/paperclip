import { describe, expect, it } from "vitest";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
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

  it("keeps the current assignee when the caller holds the in-review stage (user participant)", () => {
    // Reproduces the board-approval trap: the policy engine rejects a reassign
    // patch from the current participant without a stage decision, so the UI
    // must not pre-seed a different assignee here.
    expect(
      suggestedCommentAssigneeValue(
        {
          assigneeUserId: "local-board",
          status: "in_review",
          executionState: {
            currentParticipant: { type: "user", userId: "local-board", agentId: null },
          },
        },
        [
          { authorAgentId: "qa-agent" },
          { authorAgentId: "backend-dev-agent" },
        ],
        "local-board",
      ),
    ).toBe("user:local-board");
  });

  it("keeps the current assignee when the caller holds the in-review stage (agent participant)", () => {
    expect(
      suggestedCommentAssigneeValue(
        {
          assigneeAgentId: "qa-agent",
          status: "in_review",
          executionState: {
            currentParticipant: { type: "agent", userId: null, agentId: "qa-agent" },
          },
        },
        [{ authorAgentId: "backend-dev-agent" }],
        null,
        "qa-agent",
      ),
    ).toBe("agent:qa-agent");
  });

  it("still suggests when in_review but the caller is not the current stage participant", () => {
    expect(
      suggestedCommentAssigneeValue(
        {
          assigneeUserId: "local-board",
          status: "in_review",
          executionState: {
            currentParticipant: { type: "user", userId: "local-board", agentId: null },
          },
        },
        [{ authorAgentId: "qa-agent" }],
        "some-other-user",
      ),
    ).toBe("agent:qa-agent");
  });

  it("still suggests when the caller is currentParticipant but the issue is not in_review", () => {
    expect(
      suggestedCommentAssigneeValue(
        {
          assigneeUserId: "local-board",
          status: "in_progress",
          executionState: {
            currentParticipant: { type: "user", userId: "local-board", agentId: null },
          },
        },
        [{ authorAgentId: "qa-agent" }],
        "local-board",
      ),
    ).toBe("agent:qa-agent");
  });
});
