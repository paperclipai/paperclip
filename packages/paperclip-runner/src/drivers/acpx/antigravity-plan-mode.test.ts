import { describe, expect, it } from "vitest";
import { antigravityPlanModeAllows } from "./antigravity-plan-mode.js";

const owned = new Set(["paperclip"]);
// The 1.5.2 server's session/request_permission toolCall shapes (tools.py
// infer_tool_kind / unwrap_mcp_tool_call).
const request = (toolCall: unknown) => ({ raw: { sessionId: "native-session", toolCall } });

describe("Antigravity plan mode permissions", () => {
  it.each([
    ["a file write", { toolCallId: "w", title: "Run write_to_file?", kind: "edit", locations: [{ path: "/workspace/greeting.txt" }], rawInput: { TargetFile: "/workspace/greeting.txt", CodeContent: "hello" } }],
    ["a file edit", { toolCallId: "e", title: "Run replace_file_content?", kind: "edit", rawInput: { TargetFile: "/workspace/a.ts" } }],
    ["a terminal command", { toolCallId: "c", title: "ls -la", kind: "execute", rawInput: { CommandLine: "ls -la" } }],
    ["an unclassified tool", { toolCallId: "o", title: "Run generate_image?", kind: "other", rawInput: {} }],
    ["a tool without a kind", { toolCallId: "n", title: "Run something?", rawInput: {} }],
    ["another MCP server's tool", { toolCallId: "m", title: "github_create_issue", kind: "other", rawInput: {}, _meta: { mcp: { tool: "create_issue", server: "github" }, is_mcp_tool_call: true } }],
    ["an MCP tool that names no server", { toolCallId: "m2", title: "create_issue", kind: "other", rawInput: {}, _meta: { mcp: { tool: "create_issue" }, is_mcp_tool_call: true } }],
    ["a read claim on another MCP server's tool", { toolCallId: "m3", title: "github_read", kind: "read", rawInput: {}, _meta: { mcp: { tool: "read", server: "github" }, is_mcp_tool_call: true } }],
  ])("refuses %s", (_name, toolCall) => {
    expect(antigravityPlanModeAllows(request(toolCall), owned)).toBe(false);
  });

  it.each([
    ["a file read", { toolCallId: "r", title: "Run view_file?", kind: "read", rawInput: { AbsolutePath: "/workspace/a.ts" } }],
    ["a search", { toolCallId: "s", title: "Run grep_search?", kind: "search", rawInput: { Query: "x" } }],
    ["a page read", { toolCallId: "f", title: "Run read_url_content?", kind: "fetch", rawInput: { Url: "https://example.com" } }],
    ["a Paperclip tool", { toolCallId: "p", title: "paperclip_write_document", kind: "other", rawInput: {}, _meta: { mcp: { tool: "write_document", server: "paperclip" }, is_mcp_tool_call: true } }],
  ])("keeps %s available", (_name, toolCall) => {
    expect(antigravityPlanModeAllows(request(toolCall), owned)).toBe(true);
  });

  it("refuses malformed requests", () => {
    expect(antigravityPlanModeAllows({}, owned)).toBe(false);
    expect(antigravityPlanModeAllows(request(null), owned)).toBe(false);
    expect(antigravityPlanModeAllows(request([]), owned)).toBe(false);
  });
});
