import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { filterInboxInReviewIssues } from "./inbox-in-review";

function makeIssue(id: string, status: Issue["status"]): Issue {
  return { id, status } as Issue;
}

describe("filterInboxInReviewIssues", () => {
  const issues = [
    makeIssue("todo-1", "todo"),
    makeIssue("blocked-1", "blocked"),
    makeIssue("review-waiting-on-agent", "in_review"),
    makeIssue("review-with-open-card", "in_review"),
  ];

  it("hides in-review work that has no open ask for the viewer", () => {
    const visible = filterInboxInReviewIssues(issues, {
      attentionTaskIds: new Set(["review-with-open-card"]),
      statuses: [],
    });
    expect(visible.map((issue) => issue.id)).toEqual(["todo-1", "blocked-1", "review-with-open-card"]);
  });

  it("shows every in-review task when the viewer filters to In review", () => {
    const visible = filterInboxInReviewIssues(issues, {
      attentionTaskIds: new Set(),
      statuses: ["in_review"],
    });
    expect(visible).toEqual(issues);
  });

  it("hides nothing until the attention index has loaded", () => {
    expect(filterInboxInReviewIssues(issues, { attentionTaskIds: null, statuses: [] })).toEqual(issues);
  });
});
