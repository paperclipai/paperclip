import { describe, expect, it } from "vitest";
import { activityToastDetails } from "./activity-toast-details.js";

describe("task notification details", () => {
  it("keeps only bounded notification content from comments", () => {
    expect(activityToastDetails("issue.comment_added", {
      commentId: "comment-1", bodySnippet: "Ready for review", source: "comment",
      reopened: true, reopenedFrom: "done", secret: "private", description: "private text",
    })).toEqual({ commentId: "comment-1", bodySnippet: "Ready for review", source: "comment", reopened: true, reopenedFrom: "done" });
    expect(String(activityToastDetails("issue.comment_added", { bodySnippet: "😀".repeat(300) }).bodySnippet))
      .toBe("😀".repeat(240));
  });

  it("projects actual changes without copying titles, descriptions or assignee IDs", () => {
    expect(activityToastDetails("issue.updated", {
      status: "done", title: "unchanged title", changes: {
        status: { from: "in_progress", to: "in_review" },
        priority: { from: "medium", to: "high" },
        assigneeAgentId: { from: null, to: "agent-private-id" },
        description: { from: "private old text", to: "private new text" },
      },
    })).toEqual({ status: "in_review", statusFrom: "in_progress", priority: "high", assignment: "reassigned", descriptionChanged: true });
  });

  it("retains update context on a paired comment and suppresses the paired update", () => {
    const changes = { status: { from: "in_progress", to: "done" } };
    expect(activityToastDetails("issue.updated", { source: "comment", changes })).toEqual({ source: "comment", statusFrom: "in_progress", status: "done" });
    expect(activityToastDetails("issue.comment_added", { commentId: "c", bodySnippet: "Finished", changes })).toEqual({ commentId: "c", bodySnippet: "Finished", statusFrom: "in_progress", status: "done" });
  });

  it("supports older activity without change receipts and rejects unknown enum values", () => {
    expect(activityToastDetails("issue.updated", { status: "blocked", assigneeAgentId: null, title: "New name" }))
      .toEqual({ status: "blocked", assignment: "unassigned", titleChanged: true });
    expect(activityToastDetails("issue.updated", { status: "private text", priority: "private text", executionRunId: "run-private-id" })).toEqual({});
    expect(activityToastDetails("issue.updated", { status: "done", changes: {} })).toEqual({});
    expect(activityToastDetails("issue.updated", null)).toEqual({});
  });
});
