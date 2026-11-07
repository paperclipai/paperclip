import type { Db } from "@paperclipai/db";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

import { logger } from "../middleware/logger.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

describe("tool gateway unexpected errors", () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  it.each([
    ["/mcp/gateways/gw_fixture", "initialize"],
    ["/api/tool-gateway/gateways/fixture/mcp", "initialize"],
    ["/api/tool-gateway/tools", null],
    ["/api/tool-gateway/tools/call", "tools/call"],
  ])("conceals and logs database failures from %s", async (path, method) => {
    const error = new DrizzleQueryError(
      "select * from tool_mcp_gateway_tokens where token_hash = $1",
      ["private-bound-value"],
      new Error("database unavailable"),
    );
    const select = vi.fn(() => { throw error; });
    const db = { select } as unknown as Db;
    const gateway = createToolGatewayService(db);
    const app = express().use(express.json())
      .use(mcpGatewayProtocolRoutes(gateway))
      .use("/api", toolGatewayRoutes(db, gateway));
    const pending = method === null ? request(app).get(path) : request(app).post(path);
    const response = await pending
      .set("Authorization", "Bearer invalid-token")
      .set("x-paperclip-tool-gateway-token", "invalid-token")
      .send({ jsonrpc: "2.0", id: 1, method, tool: "fixture", params: { name: "fixture" } });

    expect(select).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), expect.any(String));
  });
});
