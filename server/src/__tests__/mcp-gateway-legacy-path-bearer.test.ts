import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

/**
 * A `pcgw_` gateway bearer is not a board key, an agent API key, or an agent
 * JWT — it is verified by the gateway service inside the protocol handler. The
 * database therefore holds no row that could match it, which is exactly the
 * live shape: the only lookups `actorMiddleware` performs must all miss.
 */
function createEmptyDb() {
  const selectChain = {
    from() {
      return {
        where() {
          return Promise.resolve([]);
        },
      };
    },
  };
  return {
    select: () => selectChain,
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;
}

/**
 * The MCP protocol handler is reached only if `actorMiddleware` lets the
 * request through, so the gateway service is stubbed down to the two calls the
 * `initialize` and `tools/list` methods make. Each records that it ran, which
 * is the assertion that matters: the pre-route middleware did not reject the
 * gateway's own bearer before the route could verify it.
 */
function createStubGateway(seen: { bearerTokens: string[] }) {
  return {
    async initializeNamedGatewayProtocol(input: { bearerToken: string }) {
      seen.bearerTokens.push(input.bearerToken);
      return { ok: true };
    },
    async listToolsForNamedGateway(input: { bearerToken: string }) {
      seen.bearerTokens.push(input.bearerToken);
      return [
        {
          name: "hindsight_recall",
          displayName: "Hindsight recall",
          description: "Recall prior context",
          parametersSchema: { type: "object", properties: {} },
        },
      ];
    },
    async createNamedGatewayToken() {
      throw new Error("createNamedGatewayToken must not be reached in these tests");
    },
  } as unknown as ToolGatewayService;
}

/**
 * Mirrors `createApp`'s ordering in `app.ts`: `actorMiddleware` is mounted
 * globally, then the public MCP protocol router, then the `/api` router that
 * carries the legacy gateway MCP path. A test that mounts the routers without
 * the middleware cannot observe this behaviour at all.
 */
function createAppWithActorMiddleware(gateway: ToolGatewayService) {
  const db = createEmptyDb();
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.use(mcpGatewayProtocolRoutes(gateway));
  const api = express.Router();
  api.use(toolGatewayRoutes(db, gateway));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

function gatewayBearer() {
  return `pcgw_${randomUUID()}.${Buffer.from(randomUUID()).toString("base64url")}`;
}

function publicGatewayId() {
  return `gw_${randomUUID().replace(/-/g, "")}`;
}

describe("MCP gateway protocol bearer reaches its route through actorMiddleware", () => {
  it("does not reject a pcgw_ bearer on the public gateway protocol path", async () => {
    const seen = { bearerTokens: [] as string[] };
    const token = gatewayBearer();

    const res = await request(createAppWithActorMiddleware(createStubGateway(seen)))
      .post(`/mcp/gateways/${publicGatewayId()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result?.serverInfo?.name).toBe("Paperclip MCP Gateway");
    expect(seen.bearerTokens).toEqual([token]);
  });

  it("does not reject a pcgw_ bearer on the legacy /api gateway MCP path", async () => {
    const seen = { bearerTokens: [] as string[] };
    const token = gatewayBearer();

    const res = await request(createAppWithActorMiddleware(createStubGateway(seen)))
      .post(`/api/tool-gateway/gateways/${randomUUID()}/mcp`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result?.serverInfo?.name).toBe("Paperclip MCP Gateway");
    expect(seen.bearerTokens).toEqual([token]);
  });

  it("carries a pcgw_ bearer through tools/list on the legacy path", async () => {
    const seen = { bearerTokens: [] as string[] };
    const token = gatewayBearer();

    const res = await request(createAppWithActorMiddleware(createStubGateway(seen)))
      .post(`/api/tool-gateway/gateways/${randomUUID()}/mcp`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", randomUUID())
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result?.tools?.[0]?.name).toBe("hindsight_recall");
    expect(seen.bearerTokens).toEqual([token]);
  });

  /**
   * The exemption must stay anchored on the trailing `/mcp` segment. The token
   * mint route sits directly beside the protocol route under the same
   * `/api/tool-gateway/gateways/:gatewayId/` prefix, so it is the closest thing
   * the exemption could wrongly swallow. An unverifiable bearer there must
   * still be rejected rather than downgraded to an unauthenticated actor.
   */
  it("still rejects an unverifiable bearer on the sibling gateway token mint route", async () => {
    const seen = { bearerTokens: [] as string[] };
    const app = createAppWithActorMiddleware(createStubGateway(seen));

    const res = await request(app)
      .post(`/api/tool-gateway/gateways/${randomUUID()}/tokens`)
      .set("Authorization", `Bearer ${gatewayBearer()}`)
      .send({ companyId: randomUUID(), name: "probe" });

    expect(res.status).toBe(401);
    expect(seen.bearerTokens).toEqual([]);
  });
});
