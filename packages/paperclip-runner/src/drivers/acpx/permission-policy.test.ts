import { describe, expect, it } from "vitest";

import {
  acpxRuntimePermissionPolicy,
  decideAcpxPermission,
  shouldAutoApproveRunnerOwnedSemanticPermission,
} from "./permission-policy.js";

describe("ACPX permission policy", () => {
  it("maps each configured mode to a closed ACP runtime policy", () => {
    expect(acpxRuntimePermissionPolicy("approve-all")).toEqual({
      defaultAction: "approve",
    });
    expect(acpxRuntimePermissionPolicy("deny-all")).toEqual({
      defaultAction: "deny",
    });
    expect(acpxRuntimePermissionPolicy("approve-reads")).toEqual({
      autoApprove: ["read", "search", "list"],
      escalate: ["execute", "write", "edit", "delete", "move"],
      defaultAction: "escalate",
    });
  });

  it.each([
    ["approve-all", "execute", "allow_once"],
    ["approve-reads", "read", "allow_once"],
    ["approve-reads", "search", "allow_once"],
    ["approve-reads", "execute", "delegate"],
    ["deny-all", "read", "reject_once"],
  ] as const)("%s maps %s to %s", (mode, inferredKind, expected) => {
    expect(
      decideAcpxPermission("claude", mode, { inferredKind, raw: {} }),
    ).toBe(expected);
  });

  it("recognizes only structural runner-owned MCP metadata", () => {
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("claude", {
        raw: {
          toolCall: {
            rawInput: { serverName: "paperclip" },
            title: "Untrusted display text",
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("claude", {
        raw: { toolCall: { name: "mcp__paperclip__paperclip_finish" } },
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("claude", {
        raw: {
          toolCall: {
            _meta: {
              claudeCode: { toolName: "mcp.paperclip.get_task_context" },
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("claude", {
        raw: {
          toolCall: { title: "mcp__paperclip__paperclip_finish" },
        },
      }),
    ).toBe(false);
  });

  it("keeps Pi and non-runner MCP servers outside semantic auto-approval", () => {
    const request = {
      raw: { toolCall: { rawInput: { serverName: "paperclip" } } },
    };
    expect(shouldAutoApproveRunnerOwnedSemanticPermission("pi", request)).toBe(
      false,
    );
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("codex", {
        raw: { toolCall: { rawInput: { serverName: "filesystem" } } },
      }),
    ).toBe(false);
  });

  it("allows Codex blanket MCP approval only when every server is runner-owned", () => {
    const request = {
      raw: {
        _meta: { is_mcp_tool_approval: true },
        toolCall: { title: "MCP approval" },
      },
    };
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("codex", request, {
        allConfiguredMcpServersAreRunnerOwned: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoApproveRunnerOwnedSemanticPermission("codex", request, {
        allConfiguredMcpServersAreRunnerOwned: false,
      }),
    ).toBe(false);
  });

  it("does not widen deny-all beyond an already authorized semantic call", () => {
    expect(
      decideAcpxPermission("claude", "deny-all", {
        inferredKind: "execute",
        raw: { toolCall: { name: "mcp__paperclip__paperclip_finish" } },
      }),
    ).toBe("allow_once");
    expect(
      decideAcpxPermission("claude", "deny-all", {
        inferredKind: "execute",
        raw: { toolCall: { title: "paperclip_finish" } },
      }),
    ).toBe("reject_once");
  });
});
