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
import { HEARTBEAT_RUN_START_GRACE_MS } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal run binding tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("terminal and never-started run bindings", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-run-binding-");
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

  async function seedCompanyAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
    return { companyId, agentId };
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

  async function readIssue(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  // A checkout that succeeds and whose binding the next request deletes is what
  // produced the reported checkout -> 409 -> checkout loop. The bind must be
  // refused instead, so the caller learns its run is dead on the first attempt.
  it.each(["cancelled", "failed", "succeeded", "timed_out", "interrupted"])(
    "refuses to check out an issue with a %s run",
    async (status) => {
      const { companyId, agentId } = await seedCompanyAgent();
      const deadRunId = randomUUID();
      const issueId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: deadRunId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
        finishedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Terminal run checkout",
        status: "todo",
        priority: "medium",
      });

      const res = await request(createApp(agentActor(companyId, agentId, deadRunId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details?.code).toBe("issue_checkout_run_not_live");

      // The refused checkout must not have written a binding.
      expect(await readIssue(issueId)).toMatchObject({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    },
  );

  it("refuses to check out with a run id that names no run", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Absent run checkout",
      status: "todo",
      priority: "medium",
    });

    const res = await request(createApp(agentActor(companyId, agentId, randomUUID())))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_checkout_run_not_live");
    expect(await readIssue(issueId)).toMatchObject({ status: "todo", checkoutRunId: null });
  });

  // A queued run past its grace is bound to be reaped, so handing it a fresh
  // binding would write a row the next request deletes — the same loop, reached
  // through a different status.
  it("refuses to check out with a queued run past the start grace", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const stuckRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: stuckRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      createdAt: new Date(Date.now() - HEARTBEAT_RUN_START_GRACE_MS - 60_000),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stuck queue checkout",
      status: "todo",
      priority: "medium",
    });

    const res = await request(createApp(agentActor(companyId, agentId, stuckRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_checkout_run_not_live");
    expect(await readIssue(issueId)).toMatchObject({ status: "todo", checkoutRunId: null });
  });

  it("still checks out with a live run", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const liveRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live run checkout",
      status: "todo",
      priority: "medium",
    });

    const res = await request(createApp(agentActor(companyId, agentId, liveRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readIssue(issueId)).toMatchObject({
      status: "in_progress",
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
    });
  });

  // A queued run that never started was the only state that actually pinned an
  // issue: nothing is terminal, so the reaper never fired and no timer existed.
  it("reaps a never-started queued run past the start grace on the assignee's write", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const stuckRunId = randomUUID();
    const liveRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: stuckRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        createdAt: new Date(Date.now() - HEARTBEAT_RUN_START_GRACE_MS - 60_000),
      },
      {
        id: liveRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stuck queued run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: stuckRunId,
      executionRunId: stuckRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, liveRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Reclaimed from a stuck queue" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readIssue(issueId)).toMatchObject({
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
    });
  });

  it("keeps a freshly queued run's binding while it can still start", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const queuedRunId = randomUUID();
    const liveRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: queuedRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        createdAt: new Date(),
      },
      {
        id: liveRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recently queued run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: queuedRunId,
      executionRunId: queuedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, liveRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Must not steal a live queue" });

    expect(res.status, JSON.stringify(res.body)).not.toBe(200);
    expect(await readIssue(issueId)).toMatchObject({
      checkoutRunId: queuedRunId,
      executionRunId: queuedRunId,
    });
  });

  // The guard used to claim "a run is live" without reading the run fields.
  it("does not claim a live run in the denial copy when the named run is dead", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const otherAgentId = randomUUID();
    const actorRunId = randomUUID();
    const deadRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: actorRunId, companyId, agentId, status: "running", invocationSource: "manual", startedAt: new Date() },
      { id: deadRunId, companyId, agentId: otherAgentId, status: "cancelled", invocationSource: "manual", finishedAt: new Date() },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock copy",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: null,
      executionRunId: deadRunId,
    });

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused" });

    expect(res.status).toBe(409);
    expect(res.body.details?.code).toBe("issue_write_assignee_run_lock");
    const copy = `${res.body.error} ${JSON.stringify(res.body.details)}`;
    expect(copy).not.toMatch(/a run is live/i);
    expect(copy).toMatch(/cancelled/i);
  });

  it("still describes a genuinely live run as live in the denial copy", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const otherAgentId = randomUUID();
    const actorRunId = randomUUID();
    const liveOtherRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: actorRunId, companyId, agentId, status: "running", invocationSource: "manual", startedAt: new Date() },
      { id: liveOtherRunId, companyId, agentId: otherAgentId, status: "running", invocationSource: "manual", startedAt: new Date() },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock copy",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: liveOtherRunId,
      executionRunId: liveOtherRunId,
    });

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused" });

    expect(res.status).toBe(409);
    const copy = `${res.body.error} ${JSON.stringify(res.body.details)}`;
    expect(copy).toMatch(/a run is live/i);
  });
});
