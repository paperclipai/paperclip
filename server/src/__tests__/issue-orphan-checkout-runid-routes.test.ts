import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

// PLA-141 regression coverage. The bug: `releaseIssueExecutionAndPromote` left
// `checkoutRunId` pointing at a now-terminal heartbeat_runs row when a routine
// run finished, which then wedged subsequent mutations on that issue. These
// tests pin the back-fill behaviour at the route layer (so PATCH/comments/
// release tolerate the orphan state) and the helper layer (so we can call it
// directly from other call sites without re-creating the SQL).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphan checkout-runid tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("orphan checkoutRunId mutation tolerance (PLA-141)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-checkout-runid-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const completedRunId = randomUUID();
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
      name: "RoutineRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: completedRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "manual",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
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

    return { companyId, agentId, completedRunId, currentRunId };
  }

  it("PATCH from the assignee succeeds when checkoutRunId points at a terminal run (back-fill)", async () => {
    const { companyId, agentId, completedRunId, currentRunId } = await seed();
    const issueId = randomUUID();
    // Orphan state: routine_execution issue still in_progress, checkoutRunId
    // points at the now-succeeded run, executionRunId already cleared (this is
    // the exact wedged state PLA-120 was observed in).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphan checkoutRunId",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: completedRunId,
      executionRunId: null,
      originKind: "routine_execution",
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.priority).toBe("high");

    const row = await db
      .select({
        priority: issues.priority,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // The assignee adopts the orphan checkout into their fresh run during the
    // PATCH: back-fill clears the terminal lock first, then assertCheckoutOwner
    // takes ownership for `currentRunId`.
    expect(row).toEqual({
      priority: "high",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("addComment from the assignee succeeds when both lock columns point at terminal runs", async () => {
    const { companyId, agentId, completedRunId, currentRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphan both locks",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: completedRunId,
      executionRunId: completedRunId,
      executionAgentNameKey: "routinerunner",
      executionLockedAt: new Date(Date.now() - 30_000),
      originKind: "routine_execution",
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "post-orphan probe" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.body).toBe("post-orphan probe");

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // After back-fill the assignee's currentRunId owns both locks again.
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("clearOrphanCheckoutLocksIfTerminal is a no-op when the checkout run is still active", async () => {
    const { companyId, agentId, currentRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "routinerunner",
      executionLockedAt: new Date(),
    });

    const svc = issueService(db);
    const cleared = await svc.clearOrphanCheckoutLocksIfTerminal(issueId);
    expect(cleared).toBe(false);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: currentRunId, executionRunId: currentRunId });
  });

  it("clearOrphanCheckoutLocksIfTerminal clears only the terminal side when one lock is live", async () => {
    const { companyId, agentId, completedRunId, currentRunId } = await seed();
    const issueId = randomUUID();
    // checkoutRunId orphaned (terminal), executionRunId still owned by a live run.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed locks",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: completedRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "routinerunner",
      executionLockedAt: new Date(),
    });

    const svc = issueService(db);
    const cleared = await svc.clearOrphanCheckoutLocksIfTerminal(issueId);
    expect(cleared).toBe(true);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: currentRunId,
      executionAgentNameKey: "routinerunner",
    });
  });
});
