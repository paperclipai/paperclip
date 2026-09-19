import { describe, expect, it } from "vitest";

import {
  acpxRuntimePermissionPolicy,
  claudePaperclipPermissionRules,
  decideAcpxPermission,
} from "./permission-policy.js";

describe("ACPX permission policy", () => {
  it("uses only catalogued reads assigned to this run, regardless of tool hints", () => {
    const tools = [
      "paperclip__get_task_context", "read_document", "write_document",
      "call_api", "request_approval", "unknown_read", "mcp__other__get_task_context",
    ].map((name) => ({ name, annotations: { readOnlyHint: true, effect: "read" } }));
    expect(claudePaperclipPermissionRules(tools, "approve-reads")).toEqual([
      "mcp__paperclip__get_task_context", "mcp__paperclip__read_document",
    ]);
    expect(claudePaperclipPermissionRules([], "approve-reads")).toEqual([]);
  });

  it("allows assigned Paperclip mutations without admitting unknown or external tools", () => {
    const tools = ["paperclip__write_document", "create_task", "reassign_task", "request_approval",
      "write_document", "mcp__other__create_task", "Bash", "unknown_write", "mcp__paperclip__create_task",
      "decide_approval", "control_workspace_service", "call_api", "create_skill", "schedule_wake"]
      .map(name => ({ name, annotations: { readOnlyHint: true } }));
    expect(claudePaperclipPermissionRules(tools, "approve-paperclip")).toEqual([
      "mcp__paperclip__create_task", "mcp__paperclip__reassign_task",
      "mcp__paperclip__request_approval", "mcp__paperclip__write_document",
    ]);
    expect(claudePaperclipPermissionRules([], "approve-paperclip")).toEqual([]);
    expect(claudePaperclipPermissionRules(tools, "deny-all")).toEqual([]);
  });

  it("maps each configured mode to a closed ACP runtime policy", () => {
    expect(acpxRuntimePermissionPolicy("approve-all")).toEqual({
      defaultAction: "approve",
    });
    expect(acpxRuntimePermissionPolicy("deny-all")).toEqual({
      defaultAction: "deny",
    });
    expect(acpxRuntimePermissionPolicy("approve-paperclip")).toEqual({ defaultAction: "escalate" });
    expect(acpxRuntimePermissionPolicy("approve-reads")).toEqual({
      defaultAction: "escalate",
    });
  });

  it.each([
    ["approve-all", "execute", "allow_once"],
    ["approve-reads", "read", "delegate"],
    ["approve-reads", "search", "delegate"],
    ["approve-reads", "execute", "delegate"],
    ["approve-paperclip", "read", "delegate"],
    ["approve-paperclip", "write", "delegate"],
    ["approve-paperclip", "execute", "delegate"],
    ["deny-all", "read", "reject_once"],
  ] as const)("%s maps %s to %s", (mode, inferredKind, expected) => {
    expect(
      decideAcpxPermission("claude", mode, { inferredKind, raw: {} }),
    ).toBe(expected);
  });

  it("keeps deny-all closed against provider-supplied semantic metadata", () => {
    for (const [agent, raw] of [
      ["claude", { toolCall: { name: "mcp__paperclip__paperclip_finish" } }],
      ["claude", { toolCall: { rawInput: { serverName: "paperclip" } } }],
      [
        "codex",
        {
          _meta: { is_mcp_tool_approval: true },
          toolCall: { title: "MCP approval" },
        },
      ],
    ] as const) {
      expect(
        decideAcpxPermission(
          agent,
          "deny-all",
          { inferredKind: "execute", raw },
          { allConfiguredMcpServersAreRunnerOwned: true },
        ),
      ).toBe("reject_once");
    }
  });

  it.each(["approve-reads", "approve-paperclip"] as const)("does not let provider metadata widen %s", (mode) => {
    for (const [agent, inferredKind, raw, options] of [
      [
        "codex",
        "execute",
        {
          _meta: { is_mcp_tool_approval: true },
          toolCall: { title: "MCP approval" },
        },
        { allConfiguredMcpServersAreRunnerOwned: true },
      ],
      [
        "claude",
        "write",
        { toolCall: { rawInput: { serverName: "paperclip" } } },
        {},
      ],
      [
        "claude",
        "execute",
        { toolCall: { name: "mcp__paperclip__paperclip_finish" } },
        {},
      ],
      [
        "claude",
        "write",
        {
          toolCall: {
            _meta: {
              claudeCode: { toolName: "mcp.paperclip.get_task_context" },
            },
          },
        },
        {},
      ],
    ] as const) {
      expect(
        decideAcpxPermission(
          agent,
          mode,
          { inferredKind, raw },
          options,
        ),
      ).toBe("delegate");
    }
  });

  it("does not trust provider-originated read classifications", () => {
    for (const inferredKind of ["read", "search", "list", "READ"]) {
      expect(
        decideAcpxPermission("codex", "approve-reads", {
          inferredKind,
          raw: {
            _meta: { is_mcp_tool_approval: true },
            toolCall: {
              name: "mcp__paperclip__get_task_context",
              rawInput: { serverName: "paperclip" },
            },
          },
        }),
      ).toBe("delegate");
    }
  });
});
