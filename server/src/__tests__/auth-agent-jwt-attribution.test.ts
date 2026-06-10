import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { hashBearerToken } from "../services/board-auth.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const boardUserId = "board-user";

function createDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === agents) {
            return Promise.resolve([
              {
                id: agentId,
                companyId,
                name: "Merger",
                status: "idle",
              },
            ]);
          }
          if (table === boardApiKeys) {
            return Promise.resolve([
              {
                id: "board-key-1",
                userId: boardUserId,
                keyHash: hashBearerToken("pcp_board_test"),
                revokedAt: null,
                expiresAt: new Date("2099-01-01T00:00:00.000Z"),
              },
            ]);
          }
          if (table === authUsers) {
            return Promise.resolve([
              {
                id: boardUserId,
                name: "Board User",
                email: "board@example.com",
              },
            ]);
          }
          if (table === companyMemberships) {
            return Promise.resolve([
              {
                companyId,
                membershipRole: "operator",
                status: "active",
              },
            ]);
          }
          if (table === instanceUserRoles) return Promise.resolve([]);
          if (table === companies) return Promise.resolve([{ id: companyId }]);
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(actorMiddleware(createDb() as never, { deploymentMode: "local_trusted" }));
  app.all("/actor", (req, res) => res.json(req.actor));
  return app;
}

describe("agent JWT actor attribution", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  it("uses a valid local agent JWT as the actor in local-trusted mode", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId);

    const res = await request(createApp())
      .post("/actor")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "comment" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    });
  });

  it("keeps board API keys on the board actor path", async () => {
    const res = await request(createApp())
      .post("/actor")
      .set("Authorization", "Bearer pcp_board_test")
      .send({ body: "comment" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: boardUserId,
      source: "board_key",
    });
  });
});
