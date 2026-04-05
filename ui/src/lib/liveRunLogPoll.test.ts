import { describe, expect, it } from "vitest";
import { filterRunsForLogPolling, isTerminalRunStatus } from "./liveRunLogPoll";

describe("isTerminalRunStatus", () => {
  it("treats finished outcomes as terminal", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("timed_out")).toBe(true);
  });

  it("treats in-flight statuses as non-terminal", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("queued")).toBe(false);
  });
});

describe("filterRunsForLogPolling", () => {
  it("drops terminal runs", () => {
    const runs = [
      { id: "a", status: "running" },
      { id: "b", status: "succeeded" },
      { id: "c", status: "failed" },
    ];
    expect(filterRunsForLogPolling(runs).map((r) => r.id)).toEqual(["a"]);
  });
});
