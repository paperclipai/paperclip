import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { activityRoutes } = await import("../routes/activity.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", activityRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describePostgres("agent action audit routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-action-audit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Audit Company",
      issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [agent, otherAgent] = await db.insert(agents).values([1, 2].map((index) => ({
      companyId: company.id,
      name: `Audit Agent ${index}`,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const issue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Audit target",
      status: "todo",
      priority: "medium",
    }).returning().then((rows) => rows[0]!);
    const comment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent.id,
      body: "A useful comment excerpt for the audit feed.",
    }).returning().then((rows) => rows[0]!);
    const document = await db.insert(documents).values({
      companyId: company.id,
      title: "Plan",
      latestBody: "Plan body",
      createdByAgentId: agent.id,
      updatedByAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const issueDocument = await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: issue.id,
      documentId: document.id,
      key: "plan",
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      responsibleUserId: "legacy-user",
    }).returning().then((rows) => rows[0]!);
    const base = new Date("2026-07-17T00:00:00.000Z");
    await db.insert(activityLog).values([
      { companyId: company.id, actorType: "agent", actorId: agent.id, action: "issue.comment.created", entityType: "issue_comment", entityId: comment.id, agentId: agent.id, runId: run.id, responsibleUserId: null, createdAt: new Date(base.getTime() + 3000) },
      { companyId: company.id, actorType: "system", actorId: "system", action: "issue.document.updated", entityType: "issue_document", entityId: issueDocument.id, agentId: agent.id, runId: run.id, responsibleUserId: "direct-user", createdAt: new Date(base.getTime() + 2000) },
      { companyId: company.id, actorType: "agent", actorId: otherAgent.id, action: "issue.updated", entityType: "issue", entityId: issue.id, agentId: otherAgent.id, responsibleUserId: "other-user", createdAt: new Date(base.getTime() + 1000) },
    ]);
    return { company, agent, otherAgent, issue, comment, issueDocument, run };
  }

  it("denies agents and board users without the audit permission", async () => {
    const { company, agent } = await seed();
    const agentResponse = await request(await createApp(db, {
      type: "agent", agentId: agent.id, companyId: company.id, runId: null, source: "agent_jwt",
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(agentResponse.status).toBe(403);

    const boardResponse = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(boardResponse.status).toBe(403);
    expect(boardResponse.body.error).toContain("audit:view_agent_actions");
  });

  it("paginates, filters, enriches entities, and falls back to the run responsible user", async () => {
    const { company, agent, otherAgent, issue, comment, issueDocument, run } = await seed();
    const app = await createApp(db, { type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false });
    const first = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0].responsibleUserId).toBe("legacy-user");
    expect(first.body.items[0].entity.comment).toEqual({ id: comment.id, excerpt: "A useful comment excerpt for the audit feed." });
    expect(first.body.items[0].entity.issue).toMatchObject({ id: issue.id, identifier: issue.identifier, title: issue.title });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items[0].entity.document).toEqual({ id: expect.any(String), key: "plan" });

    const cases = [
      [`agentId=${agent.id}`, 2],
      ["responsibleUserId=legacy-user", 1],
      [`runId=${run.id}`, 2],
      ["entityType=issue_document", 1],
      [`entityId=${issueDocument.id}`, 1],
      ["action=issue.comment", 1],
      ["actorType=system", 1],
      ["from=2026-07-17T00%3A00%3A01.500Z&to=2026-07-17T00%3A00%3A02.500Z", 1],
      [`agentId=${otherAgent.id}`, 1],
    ] as const;
    for (const [query, count] of cases) {
      const response = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?${query}`);
      expect(response.status, `${query}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body.items, query).toHaveLength(count);
    }
  });

  it("allows a signed-in board user with the explicit permission", async () => {
    const { company } = await seed();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "reader", status: "active", membershipRole: "viewer",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: "reader", permissionKey: "audit:view_agent_actions", scope: null, grantedByUserId: null,
    });
    const response = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toHaveLength(3);
  });
});
