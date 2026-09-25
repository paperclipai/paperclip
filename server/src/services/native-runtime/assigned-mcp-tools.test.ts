import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";
import { createAssignedMcpTools, getAssignedMcpGateway, registerAssignedMcpGateway } from "./assigned-mcp-tools.js";

function descriptor(name: string, risk: ToolGatewayDescriptor["risk"] = "read"): ToolGatewayDescriptor {
  return { name, displayName: name, description: `Use ${name}`, parametersSchema: { type: "object", properties: { query: { type: "string" } } }, pluginId: "fixture", providerType: "mcp_remote_http", risk };
}

function fixture(tools: ToolGatewayDescriptor[]) {
  const listToolsForNamedGateway = vi.fn().mockResolvedValue(tools);
  const executeTool = vi.fn().mockResolvedValue({ status: "completed", result: { content: [{ type: "text", text: "memory found" }] } });
  const gateway = { listToolsForNamedGateway, executeTool } as unknown as ToolGatewayService;
  return { gateway, listToolsForNamedGateway, executeTool, gatewayPublicId: "gateway-fixture", bearerToken: "private-run-token-never-project" };
}

describe("assigned MCP runner tools", () => {
  it("requires a configured gateway registered for the exact database instance", () => {
    const firstDb = {} as Db;
    const secondDb = {} as Db;
    const first = fixture([]).gateway;
    const second = fixture([]).gateway;
    expect(() => getAssignedMcpGateway(firstDb)).toThrow("assigned_mcp_gateway_unavailable");
    registerAssignedMcpGateway(firstDb, first);
    expect(getAssignedMcpGateway(firstDb)).toBe(first);
    expect(() => getAssignedMcpGateway(secondDb)).toThrow("assigned_mcp_gateway_unavailable");
    registerAssignedMcpGateway(secondDb, second);
    expect(getAssignedMcpGateway(secondDb)).toBe(second);
    expect(getAssignedMcpGateway(firstDb)).toBe(first);
    registerAssignedMcpGateway(firstDb, second);
    expect(getAssignedMcpGateway(firstDb)).toBe(second);
  });

  it("projects only authorized gateway tools with stable bounded collision-resistant names", async () => {
    const names = ["memory.search", "memory-search", "x".repeat(120), "🧠"];
    const f = fixture(names.map(name => descriptor(name)));
    const first = await createAssignedMcpTools(f);
    const reversed = await createAssignedMcpTools({ ...f, gateway: fixture([...names].reverse().map(name => descriptor(name))).gateway });
    const projected = first.definitions().map(tool => tool.name as string);
    expect(new Set(projected).size).toBe(names.length);
    for (const name of projected) {
      expect(name).toMatch(/^app_[a-zA-Z0-9_]+_[a-f0-9]{12}$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(first.has(name)).toBe(true);
    }
    expect(reversed.definitions().map(tool => tool.name)).toEqual([...projected].reverse());
    expect(f.listToolsForNamedGateway).toHaveBeenCalledWith({ gatewayPublicId: f.gatewayPublicId, bearerToken: f.bearerToken });
  });

  it("keeps the provider and action readable for fully namespaced gateway tools", async () => {
    const prefix = "mcp.app-gallery-mem0-60062edb-c211-4aae-a787-b4fa12a5ea24-f4ece062";
    const tools = ["add-memory", "search-memories", "delete-memory"].map(action => ({
      ...descriptor(`${prefix}:${action}`), displayName: `Mem0 ${action}`,
    }));
    const assigned = await createAssignedMcpTools(fixture(tools));
    for (const [index, definition] of assigned.definitions().entries()) {
      const name = definition.name as string;
      expect(name).toContain("mem0");
      expect(name).toContain(tools[index]!.name.split(":").at(-1)!.replaceAll("-", "_"));
      expect(name.length).toBeLessThanOrEqual(64);
      expect(definition.description).toBe(`${tools[index]!.displayName}: ${tools[index]!.description}`);
    }
    const long = await createAssignedMcpTools(fixture([descriptor(`${prefix}:${"long-action-".repeat(10)}`)]));
    expect((long.definitions()[0]!.name as string).length).toBeLessThanOrEqual(64);
  });

  it("does not project gateway secrets, URLs, or provider metadata and returns only the tool result", async () => {
    const tool = { ...descriptor("recall"), providerMetadata: { token: "private-provider-token", url: "https://private-gateway.example" } };
    const f = fixture([tool]);
    f.executeTool.mockResolvedValue({ status: "completed", invocationId: "internal", result: { memories: [] } });
    const assigned = await createAssignedMcpTools(f);
    const definitions = assigned.definitions();
    expect(Object.keys(definitions[0]!)).toEqual(["name", "description", "inputSchema"]);
    expect(JSON.stringify(definitions)).not.toMatch(/private-|gateway-fixture|https:/);
    const args = { query: "synthetic memory" };
    expect(await assigned.execute({ tool: definitions[0]!.name as string, arguments: args })).toEqual({ memories: [] });
    expect(f.executeTool).toHaveBeenCalledExactlyOnceWith({ gatewayPublicId: f.gatewayPublicId, sessionToken: f.bearerToken, tool: "recall", parameters: args });
    (definitions[0]!.inputSchema as Record<string, unknown>).type = "string";
    expect(assigned.definitions()[0]!.inputSchema).toEqual(tool.parametersSchema);
  });

  it("rejects unknown names without invoking the gateway", async () => {
    const f = fixture([descriptor("recall")]);
    const assigned = await createAssignedMcpTools(f);
    expect(assigned.has("unassigned")).toBe(false);
    await expect(assigned.execute({ tool: "unassigned", arguments: {} })).rejects.toThrow("assigned_mcp_tool_unknown");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it.each(["planning", "ask"] as const)("exposes and permits only read tools in %s mode", async workMode => {
    const f = fixture([descriptor("read"), descriptor("remember", "write"), descriptor("forget", "destructive")]);
    const standard = await createAssignedMcpTools(f);
    const restricted = await createAssignedMcpTools({ ...f, workMode });
    expect(restricted.definitions()).toEqual([standard.definitions()[0]]);
    for (const tool of standard.definitions().slice(1)) {
      await expect(restricted.execute({ tool: tool.name as string, arguments: {} })).rejects.toThrow("paperclip_runner_tool_mode_denied");
    }
    expect(f.executeTool).not.toHaveBeenCalled();
    await restricted.execute({ tool: restricted.definitions()[0]!.name as string, arguments: {} });
    expect(f.executeTool).toHaveBeenCalledOnce();
  });

  it("uses the gateway for write and destructive tools under standard mode without approval overrides", async () => {
    const f = fixture([descriptor("remember", "write"), descriptor("forget", "destructive")]);
    const assigned = await createAssignedMcpTools(f);
    for (const tool of assigned.definitions()) await assigned.execute({ tool: tool.name as string, arguments: {} });
    expect(f.executeTool).toHaveBeenCalledTimes(2);
    for (const [call] of f.executeTool.mock.calls) expect(call).not.toHaveProperty("approvedActionRequestId");
  });

  it.each(["planning", "ask"] as const)("enforces fresh %s mode without relaxing the pinned mode", async currentMode => {
    const f = fixture([descriptor("read"), descriptor("remember", "write")]);
    const standard = await createAssignedMcpTools(f);
    const restricted = await createAssignedMcpTools({ ...f, workMode: currentMode });
    const write = { tool: standard.definitions()[1]!.name as string, arguments: {} };
    await expect(standard.execute(write, currentMode)).rejects.toThrow("paperclip_runner_tool_mode_denied");
    await expect(restricted.execute(write, "standard")).rejects.toThrow("paperclip_runner_tool_mode_denied");
    expect(f.executeTool).not.toHaveBeenCalled();
    await standard.execute({ tool: standard.definitions()[0]!.name as string, arguments: {} }, currentMode);
    expect(f.executeTool).toHaveBeenCalledOnce();
  });

  it.each(["tool_error", "approval_required", "connection_revoked"])("propagates %s without converting it to success", async reason => {
    const f = fixture([descriptor("recall")]);
    const error = new ToolGatewayHttpError(403, "Gateway refused execution", reason);
    f.executeTool.mockRejectedValue(error);
    const assigned = await createAssignedMcpTools(f);
    await expect(assigned.execute({ tool: assigned.definitions()[0]!.name as string, arguments: {} })).rejects.toBe(error);
  });

  it("propagates discovery denial", async () => {
    const f = fixture([]);
    const error = new Error("gateway_token_revoked");
    f.listToolsForNamedGateway.mockRejectedValue(error);
    await expect(createAssignedMcpTools(f)).rejects.toBe(error);
  });

  it("rejects error payloads and incomplete outcomes, and accepts successful replay", async () => {
    const f = fixture([descriptor("recall")]);
    const assigned = await createAssignedMcpTools(f);
    const call = { tool: assigned.definitions()[0]!.name as string, arguments: {} };
    f.executeTool.mockResolvedValueOnce({ status: "completed", result: { isError: true, content: [] } });
    await expect(assigned.execute(call)).rejects.toMatchObject({ reasonCode: "tool_error" });
    f.executeTool.mockResolvedValueOnce({ status: "pending", result: {} });
    await expect(assigned.execute(call)).rejects.toThrow("assigned_mcp_tool_execution_incomplete");
    f.executeTool.mockResolvedValueOnce({ status: "replayed", result: { memory: "synthetic" } });
    await expect(assigned.execute(call)).resolves.toEqual({ memory: "synthetic" });
  });
});
