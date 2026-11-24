import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { mcpErrorMessage } from "../services/mcp-error-message.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

/**
 * A tool error carries the call's execution record (request IDs, timings, and
 * the server-side stack of the error) so the audit can store it. Agents get
 * the message and reason, never that record: they paste errors into task
 * comments, where a person would read Paperclip's internals.
 */
function failingGateway() {
  const error = new ToolGatewayHttpError(410,
    "The app no longer has this action's result: it expired or was removed. Run the action again to start it over.",
    "provider_task_expired",
    {
      connectionId: "connection-1",
      execution: {
        transport: "mcp_remote",
        request: { requestId: "paperclip-tool-123" },
        error: { name: "Error", message: "expired", code: null, stack: "Error: expired\n    at mcpTaskExpiredError (/srv/paperclip/server/src/services/tool-gateway.ts:6823:12)", cause: null },
      },
    });
  return { executeTool: async () => { throw error; } } as unknown as ToolGatewayService;
}

describe("tool errors returned to agents", () => {
  it("delivers the safe upstream message and stable reason in the MCP error envelope", async () => {
    const message = await mcpErrorMessage("Remote MCP server returned an error", {
      message: "Skill refunds was not found; TOKEN=private-provider-token",
      data: { raw: "private-provider-data" },
    }, {});
    const gateway = { executeTool: async () => { throw new ToolGatewayHttpError(502, message, "remote_mcp_error", {
      code: -32602, connectionId: "connection-1", execution: { stack: "private-audit-stack" },
    }); } } as unknown as ToolGatewayService;
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const response = await request(app).post("/mcp/gateways/gateway-1").set("Authorization", "Bearer token")
      .send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mcp.demo:load", arguments: {} } });
    expect(response.body).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32603,
      message: expect.stringContaining("Upstream message (untrusted): Skill refunds was not found"),
      data: { reasonCode: "remote_mcp_error", code: -32602, connectionId: "connection-1" } } });
    expect(JSON.stringify(response.body)).not.toMatch(/private-provider-token|private-provider-data|private-audit-stack/);
  });

  it("leave out the execution record on the MCP gateway", async () => {
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(failingGateway()));
    const response = await request(app).post("/mcp/gateways/gateway-1").set("Authorization", "Bearer token")
      .send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mcp.demo:expires", arguments: {} } });
    expect(response.body.error).toMatchObject({
      message: expect.stringContaining("Run the action again"),
      data: { reasonCode: "provider_task_expired", connectionId: "connection-1" },
    });
    expect(response.body.error.data).not.toHaveProperty("execution");
    expect(JSON.stringify(response.body)).not.toContain("tool-gateway.ts");
  });

  it("leave out the execution record on the session tool call route", async () => {
    const app = express().use(express.json()).use(toolGatewayRoutes({} as Db, failingGateway()));
    const response = await request(app).post("/tool-gateway/tools/call").set("x-paperclip-tool-gateway-token", "token")
      .send({ tool: "mcp.demo:expires", parameters: {} });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ reasonCode: "provider_task_expired", connectionId: "connection-1" });
    expect(response.body).not.toHaveProperty("execution");
    expect(JSON.stringify(response.body)).not.toContain("tool-gateway.ts");
  });
});
