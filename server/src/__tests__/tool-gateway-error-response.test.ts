import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

const RAW_DB_ERROR = 'Failed query: select "id" from "tool_gateways" where "public_id" = $1\nparams: gw_private_value';

function createApp(error: unknown) {
  const gateway = {
    initializeNamedGatewayProtocol: async () => { throw error; },
  } as unknown as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  return app;
}

describe("tool gateway error responses", () => {
  it("does not return raw internal error text to an unauthenticated protocol caller", async () => {
    const res = await request(createApp(new Error(RAW_DB_ERROR)))
      .post("/mcp/gateways/gw-public")
      .set("Authorization", "Bearer pcgw_not_a_real_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(res.text).not.toContain("Failed query");
    expect(res.text).not.toContain("gw_private_value");
  });

  it("does not return the text of a thrown non Error value", async () => {
    const res = await request(createApp(RAW_DB_ERROR))
      .post("/mcp/gateways/gw-public")
      .set("Authorization", "Bearer pcgw_not_a_real_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
