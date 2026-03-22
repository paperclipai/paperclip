import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, heartbeatRuns } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

function makeDb(opts: {
  keyRows?: unknown[];
  agentRows?: unknown[];
  runRows?: unknown[];
} = {}) {
  const keyRows = opts.keyRows ?? [];
  const agentRows = opts.agentRows ?? [];
  const runRows = opts.runRows ?? [];

  return {
    select: () => ({
      from(table: unknown) {
        const rows =
          table === agentApiKeys ? keyRows :
            table === agents ? agentRows :
              table === heartbeatRuns ? runRows :
                [];
        return {
          where: async () => rows,
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use(actorMiddleware(db as any, { deploymentMode: "authenticated" }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware run binding", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const originalSecret = process.env[secretEnv];
  const originalTtl = process.env[ttlEnv];

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    process.env[ttlEnv] = "3600";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalSecret;
    if (originalTtl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalTtl;
  });

  it("binds an active run id for agent key requests", async () => {
    const app = createApp(makeDb({
      keyRows: [{ id: "key-1", agentId: AGENT_ID, companyId: COMPANY_ID, revokedAt: null }],
      agentRows: [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active" }],
      runRows: [{ id: RUN_ID }],
    }));

    const res = await request(app)
      .get("/actor")
      .set("authorization", "Bearer pcp_test_key")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      source: "agent_key",
    });
  });

  it("drops stale or foreign run ids for agent key requests", async () => {
    const app = createApp(makeDb({
      keyRows: [{ id: "key-1", agentId: AGENT_ID, companyId: COMPANY_ID, revokedAt: null }],
      agentRows: [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active" }],
      runRows: [],
    }));

    const res = await request(app)
      .get("/actor")
      .set("authorization", "Bearer pcp_test_key")
      .set("x-paperclip-run-id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_key",
    });
    expect(res.body.runId).toBeUndefined();
  });

  it("prefers the JWT run claim over an override header", async () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", RUN_ID);
    expect(token).toBeTruthy();

    const app = createApp(makeDb({
      keyRows: [],
      agentRows: [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active" }],
      runRows: [{ id: RUN_ID }],
    }));

    const res = await request(app)
      .get("/actor")
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", "44444444-4444-4444-8444-444444444444");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      source: "agent_jwt",
    });
  });
});
