import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  boardApiKeys,
  heartbeatRuns,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDbState(input: {
  agent: { id: string; companyId: string; status?: string };
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null };
  run?: { id: string; companyId: string; agentId: string; responsibleUserId?: string | null };
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, writable: true });
  });
  app.use(errorHandler);
  return app;
}

function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + 3600,
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent auth middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "auth-middleware-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    // Pin the control-plane instance so mint/verify (and the hand-crafted
    // legacy token helper) all derive keys under the "default" live instance.
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it("uses the signed responsible_user_id claim and keeps the signed run id authoritative", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-row" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      onBehalfOfUserId: "user-claim",
      source: "agent_jwt",
    });
  });

  it("rejects mismatched run headers for agent JWTs and audits the spoof attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      details: { claimRunId: runId, headerRunId: spoofedRunId },
    });
  });

  it("falls back to the run row responsible user for legacy claim-less agent JWTs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-legacy" },
    });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      runId,
      onBehalfOfUserId: "user-legacy",
      source: "agent_jwt",
    });
  });

  it("rejects fork-minted run JWTs before issue reads or writes reach live issue data", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });

    process.env.PAPERCLIP_INSTANCE_ID = "pap-12899-worktree";
    const forkToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    expect(forkToken).not.toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const app = createApp(db);
    const readRes = await request(app)
      .get(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId);
    const writeRes = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "should not write" });

    expect(readRes.status).toBe(401);
    expect(writeRes.status).toBe(401);
  });

  it("populates agent-key actors from the key responsible user binding", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: "user-key",
      source: "agent_key",
    });
  });

  it("rejects agent keys that lack a responsible user binding and audits the denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = "pcp_test_agent_key_without_user";
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: keyId,
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: null,
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: keyId,
      details: { method: "GET", url: `/companies/${companyId}/protected` },
    });
  });
});
