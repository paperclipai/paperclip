import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, companyMemberships } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

/**
 * Resolves the Bearer agent-key path: the board-key lookup misses, the agent key
 * hits, the agent record is active and the key carries a responsible user.
 * Routed by table rather than by call order so unrelated query changes on that
 * path do not silently shift which stub row a lookup gets.
 */
function createAgentKeyDb() {
  const rowsByTable = new Map<unknown, unknown[]>([
    [
      agentApiKeys,
      [
        {
          id: "key-1",
          agentId: "agent-1",
          companyId: "company-1",
          responsibleUserId: "user-1",
          scopeConfig: null,
        },
      ],
    ],
    [agents, [{ id: "agent-1", companyId: "company-1", status: "active" }]],
    [authUsers, [{ id: "user-1" }]],
    [
      companyMemberships,
      [{ companyId: "company-1", membershipRole: "member", status: "active" }],
    ],
  ]);

  return {
    select: vi.fn(() => ({
      from(table: unknown) {
        return {
          where() {
            return Promise.resolve(rowsByTable.get(table) ?? []);
          },
        };
      },
    })),
    update: vi.fn(() => ({
      set() {
        return {
          where() {
            return Promise.resolve();
          },
        };
      },
    })),
  } as any;
}

function createApp(db: any, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.use(errorHandler);
  return app;
}

describe("actorMiddleware unsupported auth headers", () => {
  it.each(["x-api-key", "api-key", "x-auth-token"])(
    "rejects a request authenticated with %s instead of Authorization: Bearer",
    async (header) => {
      const res = await request(createApp({ select: vi.fn() }))
        .get("/actor")
        .set(header, "pcp_agent_secret");

      expect(res.status).toBe(401);
      expect(res.body.error).toContain(header);
    },
  );

  it("rejects on authenticated deployments too", async () => {
    const app = express();
    app.use(
      actorMiddleware({ select: vi.fn() } as any, {
        deploymentMode: "authenticated",
        resolveSession: async () => {
          throw new Error("session must not be resolved for a rejected request");
        },
      }),
    );
    app.get("/actor", (req, res) => res.json(req.actor));
    app.use(errorHandler);

    const res = await request(app).get("/actor").set("x-api-key", "pcp_agent_secret");

    expect(res.status).toBe(401);
  });

  it("ignores an empty unsupported header", async () => {
    const res = await request(createApp({ select: vi.fn() })).get("/actor").set("x-api-key", "");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "local_implicit" });
  });

  it("keeps the implicit local board actor when no auth header is sent", async () => {
    const res = await request(createApp({ select: vi.fn() })).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("still authenticates a valid Authorization: Bearer token", async () => {
    const res = await request(createApp(createAgentKeyDb()))
      .get("/actor")
      .set("authorization", "Bearer pcp_agent_secret");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });
  });

  it("lets Authorization: Bearer win when an unsupported header is also present", async () => {
    const res = await request(createApp(createAgentKeyDb()))
      .get("/actor")
      .set("authorization", "Bearer pcp_agent_secret")
      .set("x-api-key", "ignored");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: "agent-1", source: "agent_key" });
  });
});
