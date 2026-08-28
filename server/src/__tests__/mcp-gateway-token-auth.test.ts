import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

// A gateway bearer token as minted by `createNamedGatewayToken`:
// `pcgw_<tokenId>.<secret>`.
const GATEWAY_TOKEN = "pcgw_f51c1739-7439-4c2a-9750-4ec198bcdd09.fNPhbkqw7zhgGvyPWaBhKsPXDfZH4tvw1ZEaa5rwztA";
const GATEWAY_ID = "819f6caa-92bb-41ee-a33c-3e35bd577a8f";
const GATEWAY_PUBLIC_ID = "gw_61df2b661160478d9091986dbe51b2d8";

function createEmptyDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where() {
          // No board key, no agent key, no agent, no run: every credential
          // lookup misses, which is exactly the state a gateway token is in.
          if (table === boardApiKeys || table === agentApiKeys || table === agents || table === heartbeatRuns) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;
}

function createApp(deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(createEmptyDb(), {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  // Stand-ins for the two real MCP gateway protocol mounts. Both authenticate
  // the bearer inside the handler, so reaching the handler at all is the
  // behaviour under test.
  const echoActor = (req: express.Request, res: express.Response) => {
    res.json({ reached: true, actorType: req.actor.type, authorization: req.header("authorization") });
  };
  app.post("/mcp/gateways/:gatewayPublicId", echoActor);
  app.post("/api/tool-gateway/gateways/:gatewayId/mcp", echoActor);
  // An ordinary authenticated API route must stay closed to gateway tokens.
  app.get("/api/agents/me", echoActor);
  app.use(errorHandler);
  return app;
}

describe("MCP gateway bearer tokens and the actor middleware", () => {
  it("lets a gateway token reach the /api gateway mount the heartbeat hands to adapters", async () => {
    const res = await request(createApp())
      .post(`/api/tool-gateway/gateways/${GATEWAY_ID}/mcp`)
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
    // The route needs the raw credential to resolve its own gateway session.
    expect(res.body.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
  });

  it("lets a gateway token reach the public /mcp/gateways mount", async () => {
    const res = await request(createApp())
      .post(`/mcp/gateways/${GATEWAY_PUBLIC_ID}`)
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it("carries no ambient actor into the gateway route", async () => {
    const res = await request(createApp())
      .post(`/api/tool-gateway/gateways/${GATEWAY_ID}/mcp`)
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.body.actorType).toBe("none");
  });

  it("does not let a gateway token inherit the implicit board actor in local_trusted mode", async () => {
    const res = await request(createApp("local_trusted"))
      .post(`/api/tool-gateway/gateways/${GATEWAY_ID}/mcp`)
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.actorType).toBe("none");
  });

  it("still rejects a gateway token on any non-gateway route", async () => {
    const res = await request(createApp())
      .get("/api/agents/me")
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body.reached).toBeUndefined();
  });

  it("still rejects a non-gateway bearer on a gateway route", async () => {
    const res = await request(createApp())
      .post(`/api/tool-gateway/gateways/${GATEWAY_ID}/mcp`)
      .set("authorization", "Bearer not-a-gateway-token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(401);
    expect(res.body.reached).toBeUndefined();
  });

  it("does not treat a gateway-token-prefixed path lookalike as a gateway route", async () => {
    const res = await request(createApp())
      .get("/api/agents/me")
      .set("authorization", `Bearer ${GATEWAY_TOKEN}`)
      .query({ path: `/api/tool-gateway/gateways/${GATEWAY_ID}/mcp` });

    expect(res.status).toBe(401);
  });
});
