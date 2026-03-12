import { describe, expect, it } from "vitest";
import { summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("keeps only operator-facing summary fields and trims long text", () => {
    const summarized = summarizeHeartbeatRunResultJson({
      summary: "s".repeat(600),
      result: "Completed the implementation successfully.",
      message: "Run finished.",
      error: null,
      total_cost_usd: 1.25,
      extra: { nested: true },
    });

    expect(summarized).toEqual({
      summary: `${"s".repeat(499)}...`,
      result: "Completed the implementation successfully.",
      message: "Run finished.",
      total_cost_usd: 1.25,
    });
  });

  it("returns null when no useful summary fields exist", () => {
    expect(summarizeHeartbeatRunResultJson({ extra: true })).toBeNull();
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
  });
});
