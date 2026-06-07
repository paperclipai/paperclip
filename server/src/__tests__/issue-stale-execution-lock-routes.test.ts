import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
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
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  async function insertLockedIssue(input: {
    companyId: string;
    agentId: string;
    checkoutRunId: string;
    executionRunId?: string | null;
    title?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title ?? "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.executionRunId ?? input.checkoutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  async function insertOrphanedCheckoutIssue(input: {
    companyId: string;
    agentId: string;
    checkoutRunId: string;
    title?: string;
  }) {
    const issueId = randomUUID();
    await db.execute(sql`alter table issues disable trigger all`);
    try {
      await db.insert(issues).values({
        id: issueId,
        companyId: input.companyId,
        title: input.title ?? "Missing checkout run lock",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: input.agentId,
        checkoutRunId: input.checkoutRunId,
        executionRunId: input.checkoutRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });
    } finally {
      await db.execute(sql`alter table issues enable trigger all`);
    }
    return issueId;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
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

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("allows a same-agent successor checkout to adopt a terminal stale checkout lock and logs the adoption", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = await insertLockedIssue({ companyId, agentId, checkoutRunId: failedRunId });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checkout_lock_adopted"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.checkout_lock_adopted",
      actorType: "agent",
      agentId,
      runId: currentRunId,
      details: {
        previousCheckoutRunId: failedRunId,
        checkoutRunId: currentRunId,
        reason: "stale_checkout_run",
      },
    });
  });

  it("allows successor mutations after adopting a terminal stale checkout lock", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = await insertLockedIssue({ companyId, agentId, checkoutRunId: failedRunId });
    const app = createApp(agentActor(companyId, agentId, currentRunId));

    const checkoutRes = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(200);
    expect(checkoutRes.body).toMatchObject({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Successor run can comment after stale checkout adoption." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const documentRes = await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({
        title: "Successor plan",
        format: "markdown",
        body: "# Adopted\n\nThe successor run can write documents.",
      });
    expect(documentRes.status, JSON.stringify(documentRes.body)).toBe(201);

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Successor run can status-update after adoption." });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body).toMatchObject({
      id: issueId,
      status: "done",
    });

    const row = await db
      .select({
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "done",
    });

    const adoptionEvents = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checkout_lock_adopted"));
    expect(adoptionEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("allows same-agent release of a missing stale checkout run", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const missingRunId = randomUUID();
    const issueId = await insertOrphanedCheckoutIssue({ companyId, agentId, checkoutRunId: missingRunId });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("preserves the live-run safety invariant for same-agent checkout, mutation, and release", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: liveOwnerRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);
    const issueId = await insertLockedIssue({ companyId, agentId, checkoutRunId: liveOwnerRunId });
    const successorApp = createApp(agentActor(companyId, agentId, successorRunId));

    await request(successorApp)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] })
      .expect(409);
    await request(successorApp)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "This must not write while the owner run is live." })
      .expect(409);
    await request(successorApp)
      .post(`/api/issues/${issueId}/release`)
      .send()
      .expect(409);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
    });

    const adoptionEvents = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checkout_lock_adopted"));
    expect(adoptionEvents).toHaveLength(0);

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send()
      .expect(409);
  });

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });
});
