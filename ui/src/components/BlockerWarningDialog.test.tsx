// @vitest-environment jsdom

import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { shouldWarnOnStatusChange } from "./BlockerWarningDialog";

function blocker(overrides: Partial<IssueRelationIssueSummary> = {}): IssueRelationIssueSummary {
  return {
    id: "blocker-1",
    identifier: "PAP-1",
    title: "Blocker",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...overrides,
  };
}

describe("shouldWarnOnStatusChange", () => {
  it("warns when transitioning to in_progress with unresolved blockers", () => {
    expect(shouldWarnOnStatusChange("in_progress", [blocker()])).toBe(true);
  });

  it("warns when transitioning to in_review with unresolved blockers", () => {
    expect(shouldWarnOnStatusChange("in_review", [blocker()])).toBe(true);
  });

  it("warns when transitioning to done with unresolved blockers", () => {
    expect(shouldWarnOnStatusChange("done", [blocker({ status: "todo" })])).toBe(true);
  });

  it("does not warn for transitions to non-active statuses (backlog, todo, blocked, cancelled)", () => {
    for (const next of ["backlog", "todo", "blocked", "cancelled"]) {
      expect(shouldWarnOnStatusChange(next, [blocker()])).toBe(false);
    }
  });

  it("does not warn when blockedBy is empty or undefined", () => {
    expect(shouldWarnOnStatusChange("in_progress", [])).toBe(false);
    expect(shouldWarnOnStatusChange("in_progress", undefined)).toBe(false);
  });

  it("does not warn when all blockers are resolved (done or cancelled)", () => {
    expect(
      shouldWarnOnStatusChange("in_progress", [
        blocker({ status: "done" }),
        blocker({ id: "blocker-2", status: "cancelled" }),
      ]),
    ).toBe(false);
  });

  it("warns when at least one blocker remains unresolved among resolved siblings", () => {
    expect(
      shouldWarnOnStatusChange("in_progress", [
        blocker({ status: "done" }),
        blocker({ id: "blocker-2", status: "todo" }),
      ]),
    ).toBe(true);
  });
});
