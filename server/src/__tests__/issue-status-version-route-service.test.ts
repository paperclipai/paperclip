import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildInitialIssueMonitorFields, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("guarded promotion route/service contract", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-version-route-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Guarded promotion", issuePrefix: `V${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Paused executor", role: "engineer", adapterType: "process", status: "paused" }).returning();
    const policy = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "user", userId: "reviewer" }] }],
      monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" },
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "Promote backlog with retained monitor", status: "backlog", assigneeAgentId: agent!.id,
      executionPolicy: policy,
      ...buildInitialIssueMonitorFields({ policy, status: "in_progress", assigneeAgentId: agent!.id }),
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, issue: issue! };
  }

  it("promotes through the real service and clears a retained monitor without accepting public execution fields", async () => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await issueService(db).getById(issue.id);
    const { monitor: _monitor, ...retainedPolicy } = issue.executionPolicy!;
    expect(saved).toMatchObject({
      status: "todo", statusVersion: issue.statusVersion + 1,
      executionPolicy: retainedPolicy,
      executionState: { monitor: { status: "cleared", clearReason: "invalid_status" } },
      monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    });
    expect(saved?.executionPolicy).not.toHaveProperty("monitor");
  });

  it("derives cleanup from the locked policy after a concurrent policy-only edit", async () => {
    const { app, issue } = await fixture();
    const replacementPolicy = normalizeIssueExecutionPolicy({
      maxReviewRounds: 9,
      stages: [{ type: "approval", participants: [{ type: "user", userId: "new-reviewer" }] }],
      monitor: { nextCheckAt: "2099-02-01T00:00:00.000Z" },
    });
    let release!: () => void;
    let ready!: () => void;
    const lockReady = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const editDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let holderPid = 0;
    const edit = editDb.transaction(async (tx) => {
      await tx.update(issues).set({ executionPolicy: replacementPolicy }).where(eq(issues.id, issue.id));
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      ready();
      await gate;
    });
    await lockReady;
    const promotion = request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "todo", expectedStatusVersion: issue.statusVersion }).then((response) => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        const [result] = await probeDb.execute<{ waiting: boolean }>(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${holderPid} = any(pg_blocking_pids(pid))) as waiting
        `);
        waiting = result!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await edit;
    }
    const response = await promotion;
    expect(waiting, "promotion must wait at the service row lock").toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await issueService(db).getById(issue.id);
    const { monitor: _monitor, ...retainedPolicy } = replacementPolicy!;
    expect(saved?.executionPolicy).toEqual(retainedPolicy);
    expect(saved?.status).toBe("todo");
    expect(saved?.executionState).toMatchObject({ monitor: { status: "cleared" } });
  });

  it.each([{ executionState: null }, { executionPolicy: null }, { title: "Mixed mutation" }])("rejects a public mixed mutation %j", async (extra) => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(issue);
  });

  it("rejects derived review reassignment instead of broadening a guarded promotion", async () => {
    const { app, issue } = await fixture();
    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy)!;
    const stage = policy.stages[0]!;
    const [before] = await db.update(issues).set({
      executionState: {
        status: "pending", currentStageId: stage.id, currentStageIndex: 0, currentStageType: stage.type,
        currentParticipant: { type: "user", userId: "removed-reviewer", agentId: null },
        returnAssignee: { type: "agent", agentId: issue.assigneeAgentId, userId: null },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id)).returning();
    const response = await request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "todo", expectedStatusVersion: before!.statusVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(before);
  });

  it("rejects stale promotion before clearing its monitor", async () => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion + 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({ code: "issue_status_version_changed" });
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(issue);
  });
});
