import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });

  it("formats checklist item lifecycle activity", () => {
    expect(formatActivityVerb("issue.checklist_item_created")).toBe("added checklist item to");
    expect(formatIssueActivityAction("issue.checklist_item_created")).toBe("added checklist item");

    expect(formatActivityVerb("issue.checklist_item_deleted")).toBe("deleted checklist item from");
    expect(formatIssueActivityAction("issue.checklist_item_deleted")).toBe("deleted checklist item");
  });

  it("formats checklist item completion activity", () => {
    const completedDetails = {
      completed: true,
      _previous: { completed: false },
    };
    const reopenedDetails = {
      completed: false,
      _previous: { completed: true },
    };

    expect(formatActivityVerb("issue.checklist_item_updated", completedDetails)).toBe("completed checklist item on");
    expect(formatIssueActivityAction("issue.checklist_item_updated", completedDetails)).toBe("completed checklist item");
    expect(formatActivityVerb("issue.checklist_item_updated", reopenedDetails)).toBe("reopened checklist item on");
    expect(formatIssueActivityAction("issue.checklist_item_updated", reopenedDetails)).toBe("reopened checklist item");
  });

  it("formats checklist item title updates", () => {
    const details = {
      title: "Updated checklist item",
      _previous: { title: "Old checklist item" },
    };

    expect(formatActivityVerb("issue.checklist_item_updated", details)).toBe("renamed checklist item on");
    expect(formatIssueActivityAction("issue.checklist_item_updated", details)).toBe("renamed checklist item");
  });
});
