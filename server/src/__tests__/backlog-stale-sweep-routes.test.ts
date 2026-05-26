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
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backlog-stale-sweep route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("backlog stale sweep route — POST /api/companies/:companyId/backlog-stale-sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backlog-sweep-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
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
    app.use("/api", routineRoutes(db, {}));
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

  function unauthenticatedActor(companyId: string): Express.Request["actor"] {
    // type "none" — simulating an unauthenticated request after a hypothetical
    // auth middleware that fell through (or future "service" / "system" actor type
    // that shouldn't reach this endpoint)
    return {
      type: "none",
      companyIds: [companyId],
      source: "anonymous",
    } as unknown as Express.Request["actor"];
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

  async function seedAgent(companyId: string) {
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
    });
    return agentId;
  }

  async function seedStaleBacklogIssue(
    companyId: string,
    assigneeAgentId: string,
    options: { updatedAt: Date; backlogSweepConfig?: unknown } = { updatedAt: new Date(Date.now() - 100 * 60 * 60 * 1000) },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale backlog",
      status: "backlog",
      priority: "medium",
      assigneeAgentId,
      updatedAt: options.updatedAt,
      backlogSweepConfig: options.backlogSweepConfig as { ageThresholdHours?: number; disabled?: boolean } | undefined,
    });
    return issueId;
  }

  it("rejects unauthenticated actors with 403", async () => {
    const companyId = await seedCompany();
    const app = createApp(unauthenticatedActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("backlog-stale-sweep requires agent or board authentication");
  });

  it("accepts a board user and returns {scanned, woken} (empty DB → 0/0)", async () => {
    const companyId = await seedCompany();
    const app = createApp(boardActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 0, woken: 0 });

    const audit = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "routine.backlog_stale_sweep_run"),
        eq(activityLog.entityId, companyId),
      ));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      ageThresholdHours: 72,
      commentInactivityThresholdHours: 72,
      perAgentDailyCap: 5,
      scanned: 0,
      woken: 0,
      auditEvent: "backlog_stale_sweep_run",
    });
  });

  it("accepts an agent caller and sweeps stale backlog (1 stale issue → scanned=1, woken=1)", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const callerId = await seedAgent(companyId);
    await seedStaleBacklogIssue(companyId, assigneeId);
    const app = createApp(agentActor(companyId, callerId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBeGreaterThanOrEqual(1);
    expect(res.body.woken).toBe(1);

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "routine.backlog_stale_sweep_run"));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      scanned: expect.any(Number),
      woken: 1,
    });

    // Per-issue wake audit event should also exist
    const wakeAudit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.backlog_stale_wake_emitted"));
    expect(wakeAudit).toHaveLength(1);
    expect(wakeAudit[0].details).toMatchObject({
      agentId: assigneeId,
      auditEvent: "backlog_stale_wake_emitted",
    });
  });

  it("respects per-issue backlogSweepConfig.disabled (issue is skipped)", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const app = createApp(boardActor(companyId));
    await seedStaleBacklogIssue(companyId, assigneeId, {
      updatedAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
      backlogSweepConfig: { disabled: true },
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.woken).toBe(0);
  });

  it("honours per-agent cap on overrides via request payload", async () => {
    const companyId = await seedCompany();
    const assigneeId = await seedAgent(companyId);
    const app = createApp(boardActor(companyId));
    // Seed 3 stale issues for one agent
    for (let i = 0; i < 3; i++) {
      await seedStaleBacklogIssue(companyId, assigneeId, {
        updatedAt: new Date(Date.now() - (200 + i) * 60 * 60 * 1000),
      });
    }

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({ perAgentDailyCap: 2 });

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(3);
    expect(res.body.woken).toBe(2);
  });

  it("scopes the sweep to the path companyId — does not wake assignees in other companies", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const assigneeA = await seedAgent(companyA);
    const assigneeB = await seedAgent(companyB);
    await seedStaleBacklogIssue(companyA, assigneeA);
    await seedStaleBacklogIssue(companyB, assigneeB);

    const app = createApp(boardActor(companyA));
    const res = await request(app)
      .post(`/api/companies/${companyA}/backlog-stale-sweep`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.woken).toBe(1);

    const wakeAudit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.backlog_stale_wake_emitted"));
    expect(wakeAudit).toHaveLength(1);
    expect(wakeAudit[0].details).toMatchObject({ agentId: assigneeA });
  });

  it("rejects negative perAgentDailyCap with 400 (validator)", async () => {
    const companyId = await seedCompany();
    const app = createApp(boardActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({ perAgentDailyCap: -1 });

    expect(res.status).toBe(400);
  });

  it("rejects perAgentDailyCap over the max (50) with 400 (validator)", async () => {
    const companyId = await seedCompany();
    const app = createApp(boardActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/backlog-stale-sweep`)
      .send({ perAgentDailyCap: 999 });

    expect(res.status).toBe(400);
  });
});
