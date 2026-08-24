import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  boardTokenExceptions,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import { HIGH_INPUT_TOKEN_RUN_THRESHOLD } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { boardTokenExceptionRoutes } = await import("../routes/board-token-exceptions.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", boardTokenExceptionRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describePostgres("board token exception routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-token-exception-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(boardTokenExceptions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const company = await db.insert(companies).values({ name: "Token exception", issuePrefix: `TE${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    const otherCompany = await db.insert(companies).values({ name: "Other token exception", issuePrefix: `TO${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    const [agent, otherAgent] = await db.insert(agents).values([
      { companyId: company.id, name: "Assignee", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId: otherCompany.id, name: "Other", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    const issue = await db.insert(issues).values({ companyId: company.id, identifier: `${company.issuePrefix}-1`, title: "Guarded work", status: "in_progress", priority: "high", assigneeAgentId: agent.id }).returning().then((rows) => rows[0]!);
    const otherIssue = await db.insert(issues).values({ companyId: otherCompany.id, identifier: `${otherCompany.issuePrefix}-1`, title: "Other work", status: "todo", priority: "medium" }).returning().then((rows) => rows[0]!);
    return { company, otherCompany, agent, otherAgent, issue, otherIssue };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return { type: "board", userId: "board-user", companyIds: [companyId], source: "session", isInstanceAdmin: true };
  }

  function validPayload(issueId: string, extra: Record<string, unknown> = {}) {
    return {
      issueId,
      capTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD + 100_000,
      reason: "Board approved the bounded integration migration.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...extra,
    };
  }

  it("creates an auditable board grant and treats a matching active request as idempotent", async () => {
    const { company, issue, agent } = await seed();
    const app = await createApp(db, boardActor(company.id));
    const payload = validPayload(issue.id, { agentId: agent.id });
    const created = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ companyId: company.id, issueId: issue.id, agentId: agent.id, createdByUserId: "board-user", revokedAt: null });
    const replay = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send(payload);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.id).toBe(created.body.id);
    const conflict = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send({ ...payload, capTokens: payload.capTokens + 1 });
    expect(conflict.status).toBe(409);
  });

  it("rejects agents, including the ordinary issue assignee, before any lifecycle mutation", async () => {
    const { company, issue, agent } = await seed();
    const app = await createApp(db, { type: "agent", agentId: agent.id, companyId: company.id, runId: null, source: "agent_jwt" });
    const created = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send(validPayload(issue.id));
    expect(created.status).toBe(403);
    const revoked = await request(app).post(`/api/board-token-exceptions/${randomUUID()}/revoke`).send({ reason: "Agent cannot revoke" });
    expect(revoked.status).toBe(403);
    expect(await db.select().from(boardTokenExceptions)).toHaveLength(0);
  });

  it("validates ownership, cap, reason, and a bounded future expiry", async () => {
    const { company, otherAgent, otherIssue, issue } = await seed();
    const app = await createApp(db, boardActor(company.id));
    const cases = [
      validPayload(otherIssue.id),
      validPayload(issue.id, { agentId: otherAgent.id }),
      validPayload(issue.id, { capTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD }),
      validPayload(issue.id, { reason: "  " }),
      validPayload(issue.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      validPayload(issue.id, { expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    for (const payload of cases) {
      const response = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send(payload);
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
    }
  });

  it("records the board actor, time, and non-empty reason on guarded revocation", async () => {
    const { company, issue } = await seed();
    const app = await createApp(db, boardActor(company.id));
    const created = await request(app).post(`/api/companies/${company.id}/board-token-exceptions`).send(validPayload(issue.id));
    const revoked = await request(app).post(`/api/board-token-exceptions/${created.body.id}/revoke`).send({ reason: "The migration completed early." });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({ revokedByUserId: "board-user", revocationReason: "The migration completed early." });
    expect(revoked.body.revokedAt).toEqual(expect.any(String));
    const replay = await request(app).post(`/api/board-token-exceptions/${created.body.id}/revoke`).send({ reason: "Again" });
    expect(replay.status).toBe(409);
  });
});
