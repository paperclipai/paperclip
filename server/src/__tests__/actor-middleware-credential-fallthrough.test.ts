import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { agentApiKeys, agents, boardApiKeys } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

// Regression tests for LOOA-165: under local_trusted the actor is seeded as the
// implicit board admin before any credential is inspected. Every
// credential-resolution failure used to call next() without resetting that
// actor, so a revoked key, expired run JWT, terminated agent, or
// company-mismatched JWT was silently *promoted* to board + instance admin
// instead of being denied — voiding key revocation and agent termination on the
// default deployment mode. A presented bearer credential that resolves to no
// principal must yield 401: never a more privileged identity than presenting no
// credential at all.

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createDb(rowsFor: (table: unknown) => unknown[] = () => []) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(rowsFor(table)),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;
}

function buildApp(db: any, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(
      db,
      deploymentMode === "authenticated"
        ? { deploymentMode, resolveSession: async () => null }
        : { deploymentMode },
    ),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

const AGENT_ID = randomUUID();
const COMPANY_ID = randomUUID();

describe("actorMiddleware credential fall-through (LOOA-165)", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "credential-fallthrough-secret";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it("keeps the zero-config implicit board actor when no credential is presented", async () => {
    const res = await request(buildApp(createDb())).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("rejects an unresolvable bearer token instead of retaining the implicit board actor", async () => {
    // Also covers revoked agent keys: the key lookup filters on revokedAt, so a
    // revoked key resolves to no rows — exactly this path.
    const res = await request(buildApp(createDb()))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_totally_unresolvable");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired credential" });
    expect(res.headers["www-authenticate"]).toContain("invalid_token");
  });

  it("rejects an expired agent run JWT", async () => {
    const realNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(realNow - 2 * 60 * 60 * 1000);
    const expiredJwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", randomUUID());
    vi.useRealTimers();
    expect(expiredJwt).toBeTruthy();

    const res = await request(buildApp(createDb()))
      .get("/actor")
      .set("Authorization", `Bearer ${expiredJwt}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired credential" });
  });

  it("rejects a valid run JWT whose agent belongs to a different company", async () => {
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", randomUUID(), "user-claim");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: "other-company", status: "active" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(401);
  });

  it("rejects a valid run JWT for a terminated agent", async () => {
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", randomUUID(), "user-claim");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(401);
  });

  it("rejects an unrevoked agent key whose agent is terminated", async () => {
    const token = "pcp_agent_key_for_terminated_agent";
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) {
        return [
          {
            id: randomUUID(),
            agentId: AGENT_ID,
            companyId: COMPANY_ID,
            keyHash: hashToken(token),
            responsibleUserId: "user-key",
            revokedAt: null,
            scopeConfig: null,
          },
        ];
      }
      if (table === agents) return [{ id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" }];
      return [];
    });

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it("rejects an empty bearer token", async () => {
    // HTTP intermediaries strip trailing whitespace from header values, so
    // exercise the middleware directly to hit the empty-after-trim branch.
    const middleware = actorMiddleware(createDb(), { deploymentMode: "local_trusted" });
    const req = {
      header: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer   " : undefined),
      method: "GET",
      originalUrl: "/actor",
    } as unknown as Request;
    const statusCalls: number[] = [];
    const res = {
      set: () => res,
      status: (code: number) => {
        statusCalls.push(code);
        return res;
      },
      json: () => res,
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCalls).toEqual([401]);
    expect(next).not.toHaveBeenCalled();
    expect(req.actor).toMatchObject({ type: "none", source: "none" });
  });

  it("still resolves a valid run JWT for an active agent", async () => {
    const runId = randomUUID();
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", runId, "user-claim");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_jwt",
      runId,
    });
  });

  it("rejects an unresolvable bearer token in authenticated mode too", async () => {
    const res = await request(buildApp(createDb(), "authenticated"))
      .get("/actor")
      .set("Authorization", "Bearer nonsense-token");

    expect(res.status).toBe(401);
  });
});
