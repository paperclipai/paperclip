import { describe, expect, it } from "vitest";
import { supersededRecurringIssues } from "./recurring-issue-lifecycle.js";

describe("supersededRecurringIssues", () => {
  const issues = [
    { id: "current", title: "Founder Brief — 2026-07-17", status: "todo" },
    { id: "stale", title: "Founder Brief — 2026-07-16", status: "backlog" },
    { id: "pending", title: "Founder Brief — 2026-07-15", status: "backlog" },
    { id: "done", title: "Founder Brief — 2026-07-14", status: "done" },
    { id: "other", title: "Daily Huddle — 2026-07-16", status: "backlog" },
  ];

  it("selects only older open copies without pending decisions", () => {
    expect(
      supersededRecurringIssues(
        issues,
        "Founder Brief — 2026-07-17",
        "Founder Brief — ",
        new Set(["pending"]),
      ).map((issue) => issue.id),
    ).toEqual(["stale"]);
  });

  it("can supersede interaction-free informational digests", () => {
    expect(
      supersededRecurringIssues(
        issues,
        "Daily Huddle — 2026-07-17",
        "Daily Huddle — ",
      ).map((issue) => issue.id),
    ).toEqual(["other"]);
  });
});
