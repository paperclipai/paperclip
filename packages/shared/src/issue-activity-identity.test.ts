import { describe, expect, it } from "vitest";
import { issueActivityChangesTaskIdentity } from "./issue-activity-identity.js";

describe("issueActivityChangesTaskIdentity", () => {
  it.each([
    ["issue.created", {}],
    ["issue.child_created", null],
    ["issue.deleted", undefined],
    ["issue.updated", { title: "Renamed" }],
    ["issue.updated", { hiddenAt: "2026-11-07T00:00:00.000Z" }],
    ["issue.updated", { hiddenAt: null }],
    ["issue.updated", { changes: { title: { from: "a", to: "b" } } }],
    ["issue.updated", { changes: { hiddenAt: { from: null, to: "x" } } }],
  ])("is true for %s %j", (action, details) => {
    expect(issueActivityChangesTaskIdentity(action, details)).toBe(true);
  });

  it.each([
    ["issue.updated", { status: "in_progress", source: "comment" }],
    ["issue.updated", { changes: { status: { from: "todo", to: "done" } } }],
    ["issue.updated", null],
    ["issue.comment_added", { title: "not a rename" }],
    ["issue.checked_out", {}],
    [undefined, {}],
  ])("is false for %s %j", (action, details) => {
    expect(issueActivityChangesTaskIdentity(action, details)).toBe(false);
  });
});
