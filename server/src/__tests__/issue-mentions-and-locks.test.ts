import { describe, expect, it } from "vitest";
import {
  findMentionedAgentIdsInBody,
  shouldClearIssueExecutionLockForUpdate,
} from "../services/issues.ts";

describe("findMentionedAgentIdsInBody", () => {
  it("resolves multi-word agent mentions", () => {
    const mentioned = findMentionedAgentIdsInBody(
      "Escalating to @Trade Analyst, then handing off to @Founding Engineer.",
      [
        { id: "agent-1", name: "Trade Analyst" },
        { id: "agent-2", name: "Founding Engineer" },
      ],
    );

    expect(mentioned).toEqual(["agent-1", "agent-2"]);
  });

  it("prefers the longest matching agent name when names share a prefix", () => {
    const mentioned = findMentionedAgentIdsInBody(
      "Please ask @Trade Analyst for the next step.",
      [
        { id: "agent-short", name: "Trade" },
        { id: "agent-long", name: "Trade Analyst" },
      ],
    );

    expect(mentioned).toEqual(["agent-long"]);
  });

  it("does not treat email addresses as mentions", () => {
    const mentioned = findMentionedAgentIdsInBody(
      "ops@trade-analyst.example.com is not the same as @Trade Analyst.",
      [
        { id: "agent-1", name: "Trade Analyst" },
      ],
    );

    expect(mentioned).toEqual(["agent-1"]);
  });
});

describe("shouldClearIssueExecutionLockForUpdate", () => {
  const existing = {
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
  } as const;

  it("clears execution lock when status leaves in_progress", () => {
    expect(
      shouldClearIssueExecutionLockForUpdate(existing, { status: "blocked" }),
    ).toBe(true);
  });

  it("clears execution lock when the assignee changes", () => {
    expect(
      shouldClearIssueExecutionLockForUpdate(existing, { assigneeAgentId: "agent-2" }),
    ).toBe(true);
  });

  it("keeps execution lock for non-ownership metadata changes", () => {
    expect(
      shouldClearIssueExecutionLockForUpdate(existing, { priority: "high" }),
    ).toBe(false);
  });
});
