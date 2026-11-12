import { describe, expect, it } from "vitest";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { matchMcpAppView, runIdFromToolItemId, toolRowMatchesView } from "./mcp-app-matching";

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

describe("mcp app matching", () => {
  it("reads the run id from a tool row id", () => {
    expect(runIdFromToolItemId("run-1:tool:toolu_1")).toBe("run-1");
    expect(runIdFromToolItemId("run-1:diff:3")).toBeNull();
  });

  it("matches harness-prefixed names", () => {
    expect(toolRowMatchesView("mcp__paperclip__mcp_circleback-1a2b3c4d_displaymeetings", view("v"))).toBe(true);
    expect(toolRowMatchesView("mcp__paperclip__searchmeetings", view("v"))).toBe(false);
  });

  it("matches by run, tool and arguments", () => {
    const views = [view("a"), view("b", { toolInput: { meetingIds: ["b"] } }), view("c", { runId: "run-2" })];
    const row = { id: "run-1:tool:t1", rawName: "mcp__paperclip__displaymeetings" };
    expect(matchMcpAppView({ ...row, input: { meetingIds: ["b"] } }, views)?.id).toBe("b");
    expect(matchMcpAppView({ ...row, input: { meetingIds: ["a"] } }, views)?.id).toBe("a");
    expect(matchMcpAppView({ ...row, id: "run-2:tool:t9" }, views)?.id).toBe("c");
    expect(matchMcpAppView({ ...row, id: "run-3:tool:t9" }, views)).toBeNull();
  });
});
