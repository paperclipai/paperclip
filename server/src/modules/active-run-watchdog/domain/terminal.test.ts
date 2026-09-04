import { describe, expect, it } from "vitest";
import { isTerminalIssueStatus, shouldFoldTerminalSource } from "./terminal.js";

describe("isTerminalIssueStatus", () => {
  it.each([
    { status: "done", expected: true },
    { status: "cancelled", expected: true },
    { status: "in_progress", expected: false },
    { status: "blocked", expected: false },
    { status: null, expected: false },
    { status: undefined, expected: false },
  ])("$status -> $expected", ({ status, expected }) => {
    expect(isTerminalIssueStatus(status)).toBe(expected);
  });
});

describe("shouldFoldTerminalSource", () => {
  it("folds a terminal source only with same-run terminal evidence", () => {
    expect(
      shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: true }),
    ).toBe(true);
  });

  it("does not fold a terminal source without same-run terminal evidence", () => {
    expect(
      shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: false }),
    ).toBe(false);
  });

  it("does not fold a non-terminal source even with evidence present", () => {
    expect(
      shouldFoldTerminalSource({ sourceIssueStatus: "in_progress", hasSameRunTerminalEvidence: true }),
    ).toBe(false);
  });
});
