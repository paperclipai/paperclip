import { describe, expect, it } from "vitest";
import { getMissingIssueExecutionFailure } from "../services/heartbeat.ts";

describe("heartbeat missing issue execution guard", () => {
  it("returns a safe failure for a wakeup whose issue disappeared before execution", () => {
    expect(getMissingIssueExecutionFailure("issue-1", null)).toEqual({
      error: "Issue not found at execution time",
      errorCode: "issue_not_found",
    });
  });

  it("does not reject issue-less or resolvable execution contexts", () => {
    expect(getMissingIssueExecutionFailure(null, null)).toBeNull();
    expect(getMissingIssueExecutionFailure("issue-1", { id: "issue-1" })).toBeNull();
  });
});
