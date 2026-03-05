import { describe, expect, it } from "vitest";
import { issueStatusRequiresAssignee } from "../services/issues.js";

describe("issueStatusRequiresAssignee", () => {
  it("requires assignee for todo and in_progress", () => {
    expect(issueStatusRequiresAssignee("todo")).toBe(true);
    expect(issueStatusRequiresAssignee("in_progress")).toBe(true);
  });

  it("does not require assignee for backlog and blocked", () => {
    expect(issueStatusRequiresAssignee("backlog")).toBe(false);
    expect(issueStatusRequiresAssignee("blocked")).toBe(false);
    expect(issueStatusRequiresAssignee(null)).toBe(false);
    expect(issueStatusRequiresAssignee(undefined)).toBe(false);
  });
});
