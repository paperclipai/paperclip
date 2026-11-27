import { describe, expect, it } from "vitest";
import { antigravityPlanModeAllows } from "./antigravity-plan-mode.js";

// The runner-owned Paperclip bridge and the tools it registered for this run.
const policy = { paperclipServerOwned: true, paperclipTools: new Set(["read_agent_instructions", "write_document", "paperclip_finish"]) };
// The 1.5.2 server's session/request_permission toolCall shapes (server.py
// _permission_handler; tools.py infer_tool_kind / unwrap_mcp_tool_call).
const request = (toolCall: unknown) => ({ raw: { sessionId: "native-session", toolCall } });
const mcp = (server: string, tool: string, kind = "other") =>
  ({ toolCallId: "m", title: `${server}_${tool}`, kind, rawInput: {}, _meta: { mcp: { tool, server }, is_mcp_tool_call: true } });

describe("Antigravity plan mode permissions", () => {
  it.each([
    ["a file write", { toolCallId: "w", title: "Run write_to_file?", kind: "edit", rawInput: { TargetFile: "/workspace/greeting.txt", CodeContent: "hello" } }],
    ["a file edit", { toolCallId: "e", title: "Run replace_file_content?", kind: "edit", rawInput: { TargetFile: "/workspace/a.ts" } }],
    ["a write tool that reports itself as a read", { toolCallId: "w2", title: "Run write_to_file?", kind: "read", rawInput: {} }],
    ["a read tool name with a mismatched kind", { toolCallId: "r2", title: "Run view_file?", kind: "edit", rawInput: {} }],
    ["a terminal command", { toolCallId: "c", title: "ls -la", kind: "execute", rawInput: { CommandLine: "ls -la" } }],
    ["a terminal command that reports itself as a read", { toolCallId: "c2", title: "cat a.txt", kind: "read", rawInput: { CommandLine: "cat a.txt" } }],
    ["an unknown tool that reports itself as a read", { toolCallId: "u", title: "Run mystery_tool?", kind: "read", rawInput: {} }],
    ["an unclassified tool", { toolCallId: "o", title: "Run generate_image?", kind: "other", rawInput: {} }],
    ["a tool without a kind", { toolCallId: "n", title: "Run view_file?", rawInput: {} }],
    ["another MCP server's tool", mcp("github", "create_issue")],
    ["another MCP server's tool that claims to read", mcp("github", "read", "read")],
    ["a non-Paperclip server's tool with a Paperclip tool name", mcp("runner_extra", "write_document")],
    ["a Paperclip-server tool the bridge did not register", mcp("paperclip", "delete_company")],
    ["an MCP tool that names no server", { toolCallId: "m2", title: "create_issue", kind: "other", rawInput: {}, _meta: { mcp: { tool: "create_issue" }, is_mcp_tool_call: true } }],
    ["a read title on an MCP call", { ...mcp("github", "view_file", "read"), title: "Run view_file?" }],
  ])("refuses %s", (_name, toolCall) => {
    expect(antigravityPlanModeAllows(request(toolCall), policy)).toBe(false);
  });

  it.each([
    ["a file read", { toolCallId: "r", title: "Run view_file?", kind: "read", rawInput: { AbsolutePath: "/workspace/a.ts" } }],
    ["a search", { toolCallId: "s", title: "Run grep_search?", kind: "search", rawInput: { Query: "x" } }],
    ["a directory listing", { toolCallId: "l", title: "Run list_dir?", kind: "search", rawInput: {} }],
    ["a page read", { toolCallId: "f", title: "Run read_url_content?", kind: "fetch", rawInput: { Url: "https://example.com" } }],
    ["a registered Paperclip tool", mcp("paperclip", "write_document")],
    ["a registered Paperclip tool with a prefixed name", mcp("paperclip", "paperclip_read_agent_instructions")],
    ["Paperclip's finish tool", mcp("paperclip", "paperclip_finish")],
  ])("keeps %s available", (_name, toolCall) => {
    expect(antigravityPlanModeAllows(request(toolCall), policy)).toBe(true);
  });

  it("refuses Paperclip tools when the run's paperclip server is not runner-owned", () => {
    expect(antigravityPlanModeAllows(request(mcp("paperclip", "write_document")), { ...policy, paperclipServerOwned: false })).toBe(false);
  });

  it("refuses malformed requests", () => {
    expect(antigravityPlanModeAllows({}, policy)).toBe(false);
    expect(antigravityPlanModeAllows(request(null), policy)).toBe(false);
    expect(antigravityPlanModeAllows(request([]), policy)).toBe(false);
  });
});
