import { describe, expect, it } from "vitest";
import { issueDisplayStatus, issueExecutionStatus } from "./issue-execution";

describe("issue execution helpers", () => {
  it("reports queued before a run is claimed", () => {
    expect(issueExecutionStatus({ status: "queued", startedAt: null })).toBe("queued");
    expect(issueExecutionStatus({ status: "running", startedAt: null })).toBe("queued");
  });

  it("reports running only after startedAt exists", () => {
    expect(issueExecutionStatus({ status: "running", startedAt: "2026-03-28T06:00:00.000Z" })).toBe("running");
  });

  it("falls back to the issue workflow status when no active run exists", () => {
    const issue = { status: "todo", activeRun: null };
    expect(issueDisplayStatus(issue)).toBe("todo");
  });

  it("prefers the issue-scoped active run over the workflow status", () => {
    const issue = {
      status: "todo",
      activeRun: { status: "running", startedAt: "2026-03-28T06:00:00.000Z" },
    };
    expect(issueDisplayStatus(issue)).toBe("running");
  });
});
