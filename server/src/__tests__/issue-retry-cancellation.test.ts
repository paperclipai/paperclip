import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
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
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue retry cancellation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue retry cancellation (TON-921)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-retry-cancellation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  function issueApp(actor: Express.Request["actor"]) {
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

  function agentApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedIssueWithPendingRetry(input: {
    issueStatus?: "in_progress" | "todo" | "cancelled" | "blocked";
    retryStatus?: "scheduled_retry" | "queued";
    otherAgentId?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = input.otherAgentId ?? randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "provider quota exhausted",
      errorCode: "provider_quota",
      finishedAt: now,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "transient_failure_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.retryStatus ?? "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "transient_failure_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Quota retry issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, otherAgentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  async function readRetryStatus(runId: string) {
    const rows = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return rows[0] ?? null;
  }

  it("cancels the pending scheduled retry when the issue is cancelled", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("cancels the pending retry when the issue is blocked", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("blocked");

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("cancels a queued retry as well as a parked scheduled_retry", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithPendingRetry({
      retryStatus: "queued",
    });

    await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("leaves the pending retry alone when the issue is not closed", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Still working on it" });

    expect(res.status).toBe(200);

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("scheduled_retry");
  });

  it("does not cancel the retry of a different issue", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithPendingRetry();
    const otherIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Unrelated issue",
      status: "in_progress",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("does not fire the retry after the issue is cancelled, even once it is due", async () => {
    const { companyId, issueId, retryRunId, scheduledRetryAt } = await seedIssueWithPendingRetry();

    await request(issueApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    // The retry is now due. Drive the promotion sweep directly: a cancelled
    // issue must produce NO promoted run.
    const heartbeat = heartbeatService(db);
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(scheduledRetryAt.getTime() + 60_000));

    expect(promoted.promoted).toBe(0);
    expect(promoted.runIds).not.toContain(retryRunId);

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("lets the assignee agent cancel its own pending retry without a board key", async () => {
    const { companyId, agentId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(agentApp(agentActor(companyId, agentId)))
      .post(`/api/heartbeat-runs/${retryRunId}/cancel`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });

  it("refuses to let a different agent cancel the retry", async () => {
    const { companyId, otherAgentId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(agentApp(agentActor(companyId, otherAgentId)))
      .post(`/api/heartbeat-runs/${retryRunId}/cancel`)
      .send({});

    expect(res.status).toBe(403);

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("scheduled_retry");
  });

  it("still lets a board user cancel a pending retry", async () => {
    const { companyId, retryRunId } = await seedIssueWithPendingRetry();

    const res = await request(agentApp(boardActor(companyId)))
      .post(`/api/heartbeat-runs/${retryRunId}/cancel`)
      .send({});

    expect(res.status).toBe(200);

    const retry = await readRetryStatus(retryRunId);
    expect(retry?.status).toBe("cancelled");
  });
});
