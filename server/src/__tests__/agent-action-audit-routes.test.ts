import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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

  async function seedActorOnlyRows(companyId: string) {
    return db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        responsibleUserId: "sensitive-responsible-user",
        details: { changed: "name" },
        createdAt: new Date("2026-07-17T00:00:06.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "scheduler",
        action: "heartbeat.scheduled",
        entityType: "company",
        entityId: companyId,
        details: { schedule: "private-schedule" },
        createdAt: new Date("2026-07-17T00:00:05.000Z"),
      },
      {
        companyId,
        actorType: "plugin",
        actorId: "example-plugin",
        action: "plugin.synced",
        entityType: "company",
        entityId: companyId,
        details: { pluginConfig: "private-config" },
        createdAt: new Date("2026-07-17T00:00:04.000Z"),
      },
    ]).returning();
  }

  it("denies agents and board users without the audit permission", async () => {
    const { company, agent } = await seed();
    const agentResponse = await request(await createApp(db, {
      type: "agent", agentId: agent.id, companyId: company.id, runId: null, source: "agent_jwt",
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(agentResponse.status).toBe(403);

    const agentAllActorsResponse = await request(await createApp(db, {
      type: "agent", agentId: agent.id, companyId: company.id, runId: null, source: "agent_jwt",
    })).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all`);
    expect(agentAllActorsResponse.status, JSON.stringify(agentAllActorsResponse.body)).toBe(200);
    expect(agentAllActorsResponse.body.items).toHaveLength(3);
    expect(agentAllActorsResponse.body.items.every((item: { responsibleUserId: string | null }) => (
      item.responsibleUserId === null
    ))).toBe(true);

    const boardResponse = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(boardResponse.status).toBe(403);
    expect(boardResponse.body.error).toContain("audit:view_agent_actions");

    const invalidBoardResponse = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?limit=invalid`);
    expect(invalidBoardResponse.status).toBe(403);
    expect(invalidBoardResponse.body.error).toContain("audit:view_agent_actions");
  }, 30_000);

  it("lets a company member read basic all-actor rows without attribution", async () => {
    const { company } = await seed();
    await seedActorOnlyRows(company.id);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "reader",
      status: "active",
      membershipRole: "viewer",
    });
    const app = await createApp(db, {
      type: "board",
      userId: "reader",
      companyIds: [company.id],
      source: "session",
      isInstanceAdmin: false,
    });

    const items: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const response = await request(app)
        .get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&limit=2${cursorQuery}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      items.push(...response.body.items);
      expect(response.body.accessTier).toBe("basic");
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(items).toHaveLength(6);
    expect(new Set(items.map((item) => item.actorType))).toEqual(
      new Set(["agent", "user", "system", "plugin"]),
    );
    for (const item of items) {
      expect(item).toMatchObject({
        agentId: null,
        runId: null,
        responsibleUserId: null,
        details: null,
      });
      expect(item).toEqual(expect.objectContaining({
        actorType: expect.any(String),
        actorId: expect.any(String),
        action: expect.any(String),
        entityType: expect.any(String),
        entityId: expect.any(String),
        createdAt: expect.any(String),
      }));
    }
  });

  it("rejects the full filter set for a basic all-actors reader", async () => {
    const { company, agent, issue, run } = await seed();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "reader",
      status: "active",
      membershipRole: "viewer",
    });
    const app = await createApp(db, {
      type: "board",
      userId: "reader",
      companyIds: [company.id],
      source: "session",
      isInstanceAdmin: false,
    });
    const filters = [
      `agentId=${agent.id}`,
      "responsibleUserId=legacy-user",
      `runId=${run.id}`,
      "entityType=issue",
      `entityId=${issue.id}`,
      "action=issue.",
      "actorType=agent",
      "from=2026-07-17T00%3A00%3A00.000Z",
      "to=2026-07-18T00%3A00%3A00.000Z",
    ];

    for (const filter of filters) {
      const response = await request(app).get(
        `/api/companies/${company.id}/audit/agent-actions?actorScope=all&${filter}`,
      );
      expect(response.status, filter).toBe(403);
      expect(response.body.error).toContain("audit:view_agent_actions");
    }
  });

  it("keeps the default scope unchanged and gives permitted readers the full all-actors view", async () => {
    const { company } = await seed();
    const actorOnlyRows = await seedActorOnlyRows(company.id);
    const app = await createApp(db, {
      type: "board",
      userId: "local-board",
      companyIds: [company.id],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const defaultResponse = await request(app)
      .get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(defaultResponse.status, JSON.stringify(defaultResponse.body)).toBe(200);
    expect(defaultResponse.body.items).toHaveLength(3);
    expect(defaultResponse.body.items.map((item: { id: string }) => item.id)).not.toContain(actorOnlyRows[0]!.id);

    const allResponse = await request(app)
      .get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all`);
    expect(allResponse.status, JSON.stringify(allResponse.body)).toBe(200);
    expect(defaultResponse.body.accessTier).toBe("full");
    expect(allResponse.body.accessTier).toBe("full");
    expect(allResponse.body.items).toHaveLength(6);
    expect(allResponse.body.items.find((item: { id: string }) => item.id === actorOnlyRows[0]!.id)).toMatchObject({
      responsibleUserId: "sensitive-responsible-user",
      details: { changed: "name" },
    });
  });

  it("returns a client error for invalid audit query parameters", async () => {
    const { company } = await seed();
    const response = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?limit=invalid`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid agent action audit query");

    const scopeResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=unknown`);
    expect(scopeResponse.status).toBe(400);
    expect(scopeResponse.body.error).toBe("Invalid agent action audit query");

    const cursorResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?cursor=invalid`);
    expect(cursorResponse.status).toBe(400);
    expect(cursorResponse.body.error).toBe("Invalid audit cursor");

    const nonUuidCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-07-17T00:00:00.000000Z",
      id: "not-a-uuid",
    }), "utf8").toString("base64url");
    const nonUuidCursorResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?cursor=${encodeURIComponent(nonUuidCursor)}`);
    expect(nonUuidCursorResponse.status).toBe(400);
    expect(nonUuidCursorResponse.body.error).toBe("Invalid audit cursor");
  });

  it("preserves sub-millisecond cursor precision across pages", async () => {
    const { company, agent } = await seed();
    await db.delete(activityLog);
    const newerId = randomUUID();
    const olderId = randomUUID();
    await db.execute(sql`
      insert into activity_log (
        id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, created_at
      ) values
        (${newerId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001900Z'::timestamptz),
        (${olderId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001100Z'::timestamptz)
    `);

    const app = await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    });
    const first = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([newerId]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(
      `/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([olderId]);
    expect(second.body.nextCursor).toBeNull();
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

  it("does not enrich hidden issues or mismatched entity types", async () => {
    const { company, agent, comment, run } = await seed();
    const hiddenIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-HIDDEN`,
      title: "Hidden audit target",
      status: "todo",
      priority: "medium",
      hiddenAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    const hiddenComment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: hiddenIssue.id,
      authorAgentId: agent.id,
      body: "Hidden audit comment",
    }).returning().then((rows) => rows[0]!);
    const [hiddenActivity, hiddenDocumentActivity, mismatchedActivity] = await db.insert(activityLog).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.comment.created",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          commentId: hiddenComment.id,
          bodySnippet: hiddenComment.body,
          identifier: hiddenIssue.identifier,
          issueTitle: hiddenIssue.title,
        },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.document_updated",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          documentId: randomUUID(),
          key: "plan",
          title: "Hidden document title",
        },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "company.updated",
        entityType: "company",
        entityId: comment.id,
        agentId: agent.id,
        runId: run.id,
      },
    ]).returning();

    const response = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenActivity.id)?.entity).toEqual({
      issue: null,
      comment: null,
      document: null,
    });
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenActivity.id)?.details).toBeNull();
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenDocumentActivity.id)?.details).toBeNull();
    expect(response.body.items.find((item: { id: string }) => item.id === mismatchedActivity.id)?.entity).toEqual({
      issue: null,
      comment: null,
      document: null,
    });
  });

  it("exports the audit feed as CSV and logs the export action", async () => {
    const { company, issue, comment } = await seed();
    await db.update(issues).set({ title: "=2+2" }).where(eq(issues.id, issue.id));
    await db.update(issueComments).set({ body: "@SUM(A1)" }).where(eq(issueComments.id, comment.id));
    const app = await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    });
    const response = await request(app).get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(`agent-audit-${company.id}.csv`);

    const lines = response.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "createdAt,action,actorType,actorId,agentId,runId,responsibleUserId,entityType,entityId,issueIdentifier,issueTitle,commentExcerpt,documentKey",
    );
    // Three seeded activity rows → three CSV data rows (the export reads before it logs itself).
    expect(lines).toHaveLength(4);
    // User-controlled cells are preserved as text rather than executable formulas.
    expect(response.text).toContain("'=2+2");
    expect(response.text).toContain("'@SUM(A1)");

    // The export is itself recorded as an auditable action.
    const logged = (await db.select().from(activityLog)).filter((row) => row.action === "audit.exported");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.entityType).toBe("company");
    expect(logged[0]!.entityId).toBe(company.id);
    expect(logged[0]!.details).toMatchObject({ format: "csv", rowCount: 3, truncated: false });
  });

  it("denies CSV export without the audit permission and logs nothing", async () => {
    const { company } = await seed();
    const response = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("audit:view_agent_actions");

    const logged = (await db.select().from(activityLog)).filter((row) => row.action === "audit.exported");
    expect(logged).toHaveLength(0);
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
