import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

// Regression tests for LOOA-303: an agent process whose shell environment
// picked up a stale/foreign PAPERCLIP_API_KEY (a profile-exported static key
// for another company's agent) could authenticate as that other agent while
// stamping its writes with the current run's X-Paperclip-Run-Id, which was
// trusted unvalidated on the static-key path. The middleware now verifies that
// the named run belongs to the authenticated agent identity and fails closed
// with 403 on any mismatch, unknown run, or malformed run id. The signed-JWT
// path is already bound elsewhere (header must equal the signed run_id → 422),
// so these tests exercise the static-key delta.

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const RUN_AGENT_ID = randomUUID();
const RUN_COMPANY_ID = randomUUID();
const FOREIGN_AGENT_ID = randomUUID();
const FOREIGN_COMPANY_ID = randomUUID();
const RUN_ID = randomUUID();
const TOKEN = "pcp_static_agent_key";

function staticKeyRow(agentId: string, companyId: string) {
  return {
    id: randomUUID(),
    agentId,
    companyId,
    keyHash: hashToken(TOKEN),
    responsibleUserId: "user-key",
    revokedAt: null,
    scopeConfig: null,
  };
}

function createDb(rowsFor: (table: unknown) => unknown[]) {
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

function buildApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware run-id ↔ static-key identity binding (LOOA-303)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-identity-binding-secret";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  it("rejects a static agent key from another company presented with this run's id (the incident shape)", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(FOREIGN_AGENT_ID, FOREIGN_COMPANY_ID)];
      if (table === agents) return [{ id: FOREIGN_AGENT_ID, companyId: FOREIGN_COMPANY_ID, status: "active" }];
      if (table === heartbeatRuns) return [{ id: RUN_ID, agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Credential identity does not match the run in X-Paperclip-Run-Id" });
  });

  it("rejects a static agent key whose run id header resolves to no run at all", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(RUN_AGENT_ID, RUN_COMPANY_ID)];
      if (table === agents) return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      if (table === heartbeatRuns) return [];
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("X-Paperclip-Run-Id", randomUUID());

    expect(res.status).toBe(403);
  });

  it("rejects a malformed run id via the uuid guard, without touching the database", async () => {
    // LOOA-621: the isUuidLike(runIdHeader) guard runs *before* the lookup, so a
    // non-UUID header fails closed (403) without a query. The heartbeatRuns mock
    // is wired to throw here to prove the query is never reached — if the guard
    // regressed and the lookup fired, this DB error would now surface as a 500
    // (the try/catch that used to mask it is gone), not a 403.
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(RUN_AGENT_ID, RUN_COMPANY_ID)];
      if (table === agents) return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      if (table === heartbeatRuns) throw new Error("invalid input syntax for type uuid");
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("X-Paperclip-Run-Id", "not-a-uuid");

    expect(res.status).toBe(403);
  });

  it("surfaces a transient DB error for a valid run id as a retryable 500, not a spurious 403", async () => {
    // LOOA-621: the run-id binding lookup must not swallow genuine DB failures.
    // A well-formed run id with a valid credential that hits a transient DB
    // outage/timeout has to fail *open to a retry* (500), not masquerade as a
    // credential-identity mismatch (403) — otherwise a database blip would deny
    // every otherwise-valid agent on the primary/live server.
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(RUN_AGENT_ID, RUN_COMPANY_ID)];
      if (table === agents) return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      if (table === heartbeatRuns) throw new Error("connection terminated unexpectedly");
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(500);
  });

  it("accepts a static agent key whose run id belongs to that same agent", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(RUN_AGENT_ID, RUN_COMPANY_ID)];
      if (table === agents) return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      if (table === heartbeatRuns) return [{ id: RUN_ID, agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: RUN_AGENT_ID,
      companyId: RUN_COMPANY_ID,
      runId: RUN_ID,
      source: "agent_key",
    });
  });

  it("still resolves a static agent key normally when no run id header is present", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [staticKeyRow(RUN_AGENT_ID, RUN_COMPANY_ID)];
      if (table === agents) return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      return [];
    });

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: RUN_AGENT_ID, source: "agent_key" });
  });
});
