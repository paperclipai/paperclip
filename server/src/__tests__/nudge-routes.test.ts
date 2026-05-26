import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  nudges,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres nudge route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("nudge route — POST /api/issues/:id/nudge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-nudge-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(nudges);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, reportsTo: string | null = null) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo,
    });
    return agentId;
  }

  async function seedIssue(companyId: string, assigneeAgentId: string | null) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueId.slice(0, 6)}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
  }

  function nudgeKey(issueId: string, actorId: string, dateStr = "2026-05-24") {
    return `nudge:${issueId}:${actorId}:${dateStr}`;
  }

  it("rejects board users with 403 (agent-only endpoint)", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, assigneeId);
    const app = createApp(boardActor(companyId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "ping", idempotencyKey: nudgeKey(issueId, assigneeId) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("nudge requires agent authentication");
  });

  it("returns 404 for unknown issueId", async () => {
    const companyId = await seedCompany();
    const actorId = await seedAgent(companyId);
    const unknownIssueId = randomUUID();
    const app = createApp(agentActor(companyId, actorId));

    const res = await request(app)
      .post(`/api/issues/${unknownIssueId}/nudge`)
      .send({ reason: "ping", idempotencyKey: nudgeKey(unknownIssueId, actorId) });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("rejects with 403 nudge_not_authorized when actor has no peer-trust relationship", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const strangerId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, assigneeId);
    const app = createApp(agentActor(companyId, strangerId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "ping", idempotencyKey: nudgeKey(issueId, strangerId) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("nudge_not_authorized");
    expect(res.body.details).toMatchObject({ issueId, actorAgentId: strangerId });
  });

  it("rejects malformed idempotencyKey with 400 (validator)", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, assigneeId);
    const app = createApp(agentActor(companyId, assigneeId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "ping", idempotencyKey: "not-a-valid-key" });

    expect(res.status).toBe(400);
  });

  it("happy path: assignee nudging themselves wakes assignee + persists nudge + audit log", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, assigneeId);
    const app = createApp(agentActor(companyId, assigneeId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "self-poke for catchup", idempotencyKey: nudgeKey(issueId, assigneeId) });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      nudgeId: expect.any(String),
      woke: true,
      rateLimited: false,
    });

    const persisted = await db.select().from(nudges).where(eq(nudges.id, res.body.nudgeId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      companyId,
      actorAgentId: assigneeId,
      targetIssueId: issueId,
      targetAssigneeAgentId: assigneeId,
      reason: "self-poke for catchup",
      woke: true,
      rateLimited: false,
    });

    const audit = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "issue.peer_nudge_emitted"),
        eq(activityLog.entityId, issueId),
      ));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      nudgeId: res.body.nudgeId,
      actorAgentId: assigneeId,
      targetAssigneeAgentId: assigneeId,
      reason: "self-poke for catchup",
      woke: true,
      auditEvent: "peer_nudge_emitted",
    });
  });

  it("happy path with no assignee: nudge recorded, woke=false, audit emitted", async () => {
    const companyId = await seedCompany();
    const actorId = await seedAgent(companyId);
    // Issue with no assignee — but actor must still pass trust check. Without
    // assignee, only the "actor is in the chain of command above the assignee" branch
    // is the only thing — and that returns false with no assignee. So this test
    // requires another relationship. Use a goal-sibling: seed the actor on a sibling
    // issue under the same goalId.
    const targetIssueId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    await db.execute(/* sql */`INSERT INTO projects (id, company_id, name) VALUES ('${projectId}', '${companyId}', 'Project')`);
    await db.execute(/* sql */`INSERT INTO goals (id, company_id, project_id, title) VALUES ('${goalId}', '${companyId}', '${projectId}', 'Goal')`);
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      title: "Unassigned target",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      goalId,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Actor's sibling",
      status: "todo",
      priority: "medium",
      assigneeAgentId: actorId,
      goalId,
    });
    const app = createApp(agentActor(companyId, actorId));

    const res = await request(app)
      .post(`/api/issues/${targetIssueId}/nudge`)
      .send({ reason: "fyi", idempotencyKey: nudgeKey(targetIssueId, actorId) });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      nudgeId: expect.any(String),
      woke: false,
      rateLimited: false,
    });

    const persisted = await db.select().from(nudges).where(eq(nudges.id, res.body.nudgeId));
    expect(persisted[0]).toMatchObject({
      targetAssigneeAgentId: null,
      woke: false,
    });
  });

  it("duplicate idempotencyKey returns existing nudge with rateLimited=true (no new wake)", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, assigneeId);
    const app = createApp(agentActor(companyId, assigneeId));
    const key = nudgeKey(issueId, assigneeId);

    const firstRes = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "first", idempotencyKey: key });
    expect(firstRes.status).toBe(202);
    expect(firstRes.body.rateLimited).toBe(false);
    const firstId = firstRes.body.nudgeId;

    const secondRes = await request(app)
      .post(`/api/issues/${issueId}/nudge`)
      .send({ reason: "second", idempotencyKey: key });
    expect(secondRes.status).toBe(202);
    expect(secondRes.body).toMatchObject({
      nudgeId: firstId,
      woke: false,
      rateLimited: true,
    });

    // Only one nudge row should exist
    const rows = await db.select().from(nudges).where(eq(nudges.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("first"); // second call did not overwrite

    // Only one audit row should exist (second was short-circuited before logActivity)
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "issue.peer_nudge_emitted"));
    expect(audit).toHaveLength(1);
  });

  it("two actors using the same idempotencyKey both succeed (no cross-actor slot squatting)", async () => {
    const companyId = await seedCompany();
    const actorA = await seedAgent(companyId);
    const actorB = await seedAgent(companyId);
    const targetIssueId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    await db.execute(/* sql */`INSERT INTO projects (id, company_id, name) VALUES ('${projectId}', '${companyId}', 'Project')`);
    await db.execute(/* sql */`INSERT INTO goals (id, company_id, project_id, title) VALUES ('${goalId}', '${companyId}', '${projectId}', 'Goal')`);
    // Target is unassigned but on the shared goal so both actors pass peer-trust
    // (goal-sibling positive). Both A and B own a sibling issue on the same goal.
    await db.insert(issues).values({
      id: targetIssueId, companyId, title: "Target", status: "todo",
      priority: "medium", assigneeAgentId: null, goalId,
    });
    await db.insert(issues).values({
      id: randomUUID(), companyId, title: "A's sibling", status: "todo",
      priority: "medium", assigneeAgentId: actorA, goalId,
    });
    await db.insert(issues).values({
      id: randomUUID(), companyId, title: "B's sibling", status: "todo",
      priority: "medium", assigneeAgentId: actorB, goalId,
    });

    // Both actors send the SAME idempotency key. Pre-fix this would let B
    // squat A's slot (or vice versa); post-fix they produce distinct rows
    // because the lookup is keyed on (companyId, actorAgentId, idempotencyKey).
    const sharedKey = nudgeKey(targetIssueId, actorA);
    const resA = await request(createApp(agentActor(companyId, actorA)))
      .post(`/api/issues/${targetIssueId}/nudge`)
      .send({ reason: "from A", idempotencyKey: sharedKey });
    expect(resA.status).toBe(202);
    expect(resA.body.rateLimited).toBe(false);

    const resB = await request(createApp(agentActor(companyId, actorB)))
      .post(`/api/issues/${targetIssueId}/nudge`)
      .send({ reason: "from B", idempotencyKey: sharedKey });
    expect(resB.status).toBe(202);
    expect(resB.body.rateLimited).toBe(false);
    expect(resB.body.nudgeId).not.toBe(resA.body.nudgeId);

    const rows = await db.select().from(nudges).where(eq(nudges.companyId, companyId));
    expect(rows).toHaveLength(2);
    const actors = new Set(rows.map((r) => r.actorAgentId));
    expect(actors).toEqual(new Set([actorA, actorB]));
  });

  it("enforces 20-per-24h company-wide actor rate limit (21st nudge → 429)", async () => {
    const companyId = await seedCompany();
    const actorId = await seedAgent(companyId);
    // Seed 20 distinct target issues so each nudge has a unique idempotency key
    const issueIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await seedIssue(companyId, actorId);
      issueIds.push(id);
    }
    const app = createApp(agentActor(companyId, actorId));

    // Fire 20 nudges — all should succeed
    for (const issueId of issueIds) {
      const res = await request(app)
        .post(`/api/issues/${issueId}/nudge`)
        .send({
          reason: "rl test",
          idempotencyKey: nudgeKey(issueId, actorId),
        });
      expect(res.status).toBe(202);
    }

    // 21st nudge against a new issue — should 429
    const extraIssue = await seedIssue(companyId, actorId);
    const res = await request(app)
      .post(`/api/issues/${extraIssue}/nudge`)
      .send({
        reason: "over limit",
        idempotencyKey: nudgeKey(extraIssue, actorId),
      });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("nudge_quota_exceeded");
    expect(res.body.details).toMatchObject({
      companyId,
      actorAgentId: actorId,
      dailyLimit: 20,
    });

    // Only 20 nudges should be persisted
    const persisted = await db.select().from(nudges).where(eq(nudges.actorAgentId, actorId));
    expect(persisted).toHaveLength(20);
  });
});
