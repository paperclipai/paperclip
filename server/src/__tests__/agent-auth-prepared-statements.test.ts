import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { fillPlaceholders, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentAuthenticationQuery, actorMiddleware, responsibleUserMembershipsQuery } from "../middleware/auth.js";
import { agentRunAuthenticationQuery } from "../middleware/agent-run-authentication.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("agent request authentication statements", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), userId = `user-${randomUUID()}`;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "agent-auth-prepared-statements-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-auth-prepared-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Prepared authentication", issuePrefix: "PREP" });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: "owner@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", lifecycleHolds: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId,
      resultJson: { executionCancellation: { state: "none" }, freshContinuationSupersededAt: null },
      contextSnapshot: { conversationMode: true, issueId: randomUUID() } });
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  }, 60_000);

  const cases = () => [
    {
      bound: agentAuthenticationQuery(db, agentId),
      prepared: agentAuthenticationQuery(db, sql.placeholder("agentId")),
      values: { agentId },
    },
    {
      bound: agentRunAuthenticationQuery(db, { runId, companyId, agentId }),
      prepared: agentRunAuthenticationQuery(db, { runId: sql.placeholder("runId"), companyId: sql.placeholder("companyId"),
        agentId: sql.placeholder("agentId") }),
      values: { runId, companyId, agentId },
    },
    {
      bound: responsibleUserMembershipsQuery(db, { companyId, userId }),
      prepared: responsibleUserMembershipsQuery(db, { companyId: sql.placeholder("companyId"), userId: sql.placeholder("userId") }),
      values: { companyId, userId },
    },
  ];

  it("sends the same statement and returns the same rows as the query builder", async () => {
    for (const { bound, prepared, values } of cases()) {
      const statement = prepared.prepare("fixture");
      const built = bound.toSQL(), placeholders = prepared.toSQL();
      expect(placeholders.sql).toBe(built.sql);
      expect(fillPlaceholders(statement.getQuery().params, values)).toEqual(built.params);
      const rows = await bound;
      expect(rows).toHaveLength(1);
      expect(await statement.execute(values)).toStrictEqual(rows);
    }
  });

  it("builds the request authentication statements once per database client", async () => {
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/actor", (req, res) => { res.json(req.actor); });
    const token = createLocalAgentJwt(agentId, companyId, "process", runId, userId)!;
    const call = () => request(app).get("/actor").set("authorization", `Bearer ${token}`).set("x-paperclip-run-id", runId);

    const select = vi.spyOn(db, "select");
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ type: "agent", agentId, companyId, runId, onBehalfOfUserId: userId,
      onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] });
    select.mockClear();

    for (let index = 0; index < 3; index += 1) {
      const next = await call();
      expect(next.status).toBe(200);
      expect(next.body).toEqual(first.body);
    }
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });
});
