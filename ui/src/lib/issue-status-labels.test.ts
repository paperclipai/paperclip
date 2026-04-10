import { describe, expect, it } from "vitest";
import { formatIssueStatusLabel } from "./issue-status-labels";

describe("formatIssueStatusLabel", () => {
  it("shows QA for in_review", () => {
    expect(formatIssueStatusLabel("in_review")).toBe("QA");
  });

  it("humanizes other issue statuses", () => {
    expect(formatIssueStatusLabel("in_progress")).toBe("In Progress");
    expect(formatIssueStatusLabel("done")).toBe("Done");
  });
});
