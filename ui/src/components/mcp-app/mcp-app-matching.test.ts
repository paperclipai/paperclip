import { describe, expect, it } from "vitest";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { createMcpAppViewIndex, mcpAppViewIndexFor } from "./mcp-app-matching";
import { mcpAppToolDisplayName } from "./McpAppTurnViews";

function view(id: string, overrides: Partial<McpAppViewSummary> = {}): McpAppViewSummary {
  return {
    id,
    issueId: "issue-1",
    runId: "run-1",
    connectionId: "conn-1",
    applicationName: "Circleback",
    toolName: "mcp.circleback-1a2b3c4d:displaymeetings",
    upstreamToolName: "DisplayMeetings",
    resourceUri: "ui://circleback/meetings",
    toolInput: { meetingIds: ["a"] },
    createdAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("mcp app view index", () => {
  it("groups views by run in call order and ignores views without a run", () => {
    const index = createMcpAppViewIndex([view("a"), view("b", { runId: "run-2" }), view("c"), view("d", { runId: null })]);
    expect(index.forRun("run-1").map((v) => v.id)).toEqual(["a", "c"]);
    expect(index.forRun("run-2").map((v) => v.id)).toEqual(["b"]);
    expect(index.forRun("run-3")).toEqual([]);
  });

  it("builds one index per loaded list and answers each reply without rescanning", () => {
    // Realistic upper bound: 200 saved views over 100 runs, 2,000 rendered replies.
    const views = Array.from({ length: 200 }, (_, index) => view(`v${index}`, { runId: `run-${index % 100}` }));
    const index = mcpAppViewIndexFor(views);
    expect(mcpAppViewIndexFor(views)).toBe(index);
    const started = performance.now();
    const counts = Array.from({ length: 2000 }, (_, reply) => index.forRun(`run-${reply % 100}`).length);
    expect(performance.now() - started).toBeLessThan(50);
    expect(counts.every((count) => count === 2)).toBe(true);
  });

  it("names tools for people", () => {
    expect(mcpAppToolDisplayName("DisplayMeetings")).toBe("Display meetings");
    expect(mcpAppToolDisplayName("display_calendar_events")).toBe("Display calendar events");
  });
});
