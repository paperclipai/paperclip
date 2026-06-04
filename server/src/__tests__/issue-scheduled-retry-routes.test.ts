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
  issueTreeHolds,
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
    `Skipping embedded Postgres scheduled retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue scheduled retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-scheduled-retry-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
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

  async function seedIssueWithRetry(input: {
    agentStatus?: "active" | "paused";
    retryStatus?: "scheduled_retry" | "queued" | "running";
    issueStatus?: "in_progress" | "todo" | "done" | "cancelled";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
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
        wakeReason: "bounded_transient_heartbeat_retry",
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
      title: "Retryable issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  it("surfaces the current scheduled retry in the issue read model", async () => {
    const { companyId, issueId, agentId, sourceRunId, retryRunId, scheduledRetryAt } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(companyId))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: retryRunId,
      status: "scheduled_retry",
      agentId,
      agentName: "CodexCoder",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
    });
    expect(res.body.scheduledRetry.scheduledRetryAt).toBe(scheduledRetryAt.toISOString());
  });

  it("promotes the existing scheduled retry and treats duplicate clicks as idempotent", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const app = createApp(boardActor(companyId));

    const first = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const second = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, first.body.scheduledRetry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]).toMatchObject({ id: retryRunId, status: "queued" });
  });

  it("returns a clear no-op response when there is no scheduled retry", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "NONE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No retry",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "NONE-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_scheduled_retry",
      scheduledRetry: null,
    });
  });

  it("reports already-promoted retries without creating another run", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });
  });

  it("uses normal promotion gates and records gate-suppressed retries", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "agent_not_invokable",
      },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({ status: "cancelled", errorCode: "agent_not_invokable" });

    const [activity] = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual({
      action: "issue.scheduled_retry_retry_now",
      entityId: issueId,
      runId: retryRunId,
    });
  });

  it("requires board access for retry-now", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithRetry();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("enforces company scoping for retry-now", async () => {
    const { issueId } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("suppresses retry-now when the issue is under a budget hard-stop", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget" })
      .where(eq(agents.id, agentId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "budget_blocked",
      },
    });
  });

  it("suppresses retry-now when the issue is waiting on another review participant", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry({ issueStatus: "in_progress" });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db
      .update(issues)
      .set({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "issue_review_participant_changed",
      },
    });
  });

  it("suppresses retry-now when the issue is under an active subtree pause hold", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual pause for review",
      releasePolicy: { strategy: "manual" },
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "issue_paused",
      },
    });
  });

  it("suppresses retry-now when unresolved blockers remain", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Blocking task",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
      identifier: "BLOCK-2",
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "issue_dependencies_blocked",
      },
    });
  });

  it("suppresses retry-now when the issue already reached a terminal status", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ issueStatus: "done" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "issue_terminal_status",
      },
    });
  });
});
