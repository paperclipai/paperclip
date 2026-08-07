import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
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
import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

const adapterControl = vi.hoisted(() => {
  const releaseCurrentRuns: Array<() => void> = [];
  let startedResolver: (() => void) | null = null;
  let startedPromise = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });

  const reset = () => {
    releaseCurrentRuns.length = 0;
    startedPromise = new Promise<void>((resolve) => {
      startedResolver = resolve;
    });
  };

  return {
    execute: vi.fn(async () => {
      startedResolver?.();
      await new Promise<void>((resolve) => {
        releaseCurrentRuns.push(resolve);
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Blocked interaction wake completed.",
        provider: "test",
        model: "test-model",
      };
    }),
    waitForStart: () => startedPromise,
    release: () => releaseCurrentRuns.shift()?.(),
    releaseAll: () => {
      while (releaseCurrentRuns.length > 0) {
        releaseCurrentRuns.shift()?.();
      }
    },
    reset,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: adapterControl.execute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping blocked interaction lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ACTIVE_HEARTBEAT_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const ACTIVE_WAKEUP_REQUEST_STATUSES = new Set(["queued", "deferred_issue_execution", "claimed"]);

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function waitForHeartbeatSideEffectsToSettle(db: ReturnType<typeof createDb>, timeoutMs = 20_000) {
  let lastSnapshot: string | null = null;
  let stableSince = 0;

  return waitForCondition(async () => {
    const [runRows, wakeRows, runEventRows, activityRows, commentRows] = await Promise.all([
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns),
      db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests),
      db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents),
      db.select({ id: activityLog.id }).from(activityLog),
      db.select({ id: issueComments.id }).from(issueComments),
    ]);
    if (runRows.some((row) => ACTIVE_HEARTBEAT_RUN_STATUSES.has(row.status))) {
      lastSnapshot = null;
      stableSince = 0;
      return false;
    }
    if (wakeRows.some((row) => ACTIVE_WAKEUP_REQUEST_STATUSES.has(row.status))) {
      lastSnapshot = null;
      stableSince = 0;
      return false;
    }

    const snapshot = [
      runRows.length,
      wakeRows.length,
      wakeRows.map((row) => row.status).sort().join(","),
      runEventRows.length,
      activityRows.length,
      commentRows.length,
    ].join(":");
    const now = Date.now();
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      stableSince = now;
      return false;
    }

    return stableSince > 0 && now - stableSince >= 150;
  }, timeoutMs);
}

describeEmbeddedPostgres("blocked interaction wakes do not claim issue execution locks", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-interaction-lock-routes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    adapterControl.releaseAll();
    await waitForHeartbeatSideEffectsToSettle(db);
    adapterControl.reset();
    runningProcesses.clear();
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }, 30_000);

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

  function agentActor(companyId: string, agentId: string, runId?: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      ...(runId ? { runId } : {}),
      source: "agent_jwt",
    };
  }

  async function seedScenario(
    issueStatus: "blocked" | "cancelled" = "blocked",
    options?: { includeBlockerRelation?: boolean },
  ) {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const foreignAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const issueId = randomUUID();
    const includeBlockerRelation = options?.includeBlockerRelation ?? true;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "QAEng",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: foreignAgentId,
        companyId,
        name: "CEO",
        role: "executive",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Live blocker",
        status: "blocked",
        priority: "high",
        assigneeAgentId: foreignAgentId,
        responsibleUserId: "local-board",
      },
      {
        id: issueId,
        companyId,
        title: "Blocked QA issue",
        status: issueStatus,
        priority: "high",
        assigneeAgentId,
        responsibleUserId: "local-board",
      },
    ]);

    if (includeBlockerRelation) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }

    return { companyId, assigneeAgentId, foreignAgentId, issueId };
  }

  async function startBlockedInteractionWake(
    agentId: string,
    issueId: string,
    wakeReason: "issue_commented" | "issue_comment_mentioned" = "issue_comment_mentioned",
  ) {
    const commentId = randomUUID();
    const source = wakeReason === "issue_commented" ? "issue.comment" : "comment.mention";
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: wakeReason,
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason,
        source,
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(run).not.toBeNull();
    await adapterControl.waitForStart();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0]?.status === "running")
    );
    return run!;
  }

  it("keeps the issue unlocked for same-assignee blocked interaction wakes", async () => {
    const { companyId, assigneeAgentId, issueId } = await seedScenario();
    const run = await startBlockedInteractionWake(assigneeAgentId, issueId);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const issueRes = await request(createApp(agentActor(companyId, assigneeAgentId))).get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );

    const rowAfterRun = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(rowAfterRun).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("keeps the issue unlocked for foreign mention wakes on blocked issues", async () => {
    const { companyId, foreignAgentId, issueId } = await seedScenario();
    const run = await startBlockedInteractionWake(foreignAgentId, issueId);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const issueRes = await request(createApp(agentActor(companyId, foreignAgentId))).get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );

    const rowAfterRun = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(rowAfterRun).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("keeps the issue unlocked after a foreign blocked mention wake posts a comment-only triage", async () => {
    const { companyId, assigneeAgentId, foreignAgentId, issueId } = await seedScenario();
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: `For visibility: [@CEO](agent://${foreignAgentId})`,
      authorAgentId: assigneeAgentId,
    });
    const run = await startBlockedInteractionWake(foreignAgentId, issueId);

    const commentRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "Triage only: the blocker is still unresolved, so I am not checking this issue out.",
      });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const issueRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });

  it("stays unlocked after a blocked comment wake gets a 422 checkout and then posts triage", async () => {
    const { companyId, assigneeAgentId, foreignAgentId, issueId } = await seedScenario();
    const run = await startBlockedInteractionWake(assigneeAgentId, issueId, "issue_commented");

    const checkoutRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: assigneeAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(422);
    expect(checkoutRes.body).toMatchObject({
      error: "Issue is blocked by unresolved blockers",
    });

    const commentRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: `Still blocked after checkout triage. [@CEO](agent://${foreignAgentId}) for visibility.`,
      });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const issueRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    const contextRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .get(`/api/issues/${issueId}/heartbeat-context`);
    expect(contextRes.status, JSON.stringify(contextRes.body)).toBe(200);
    expect(contextRes.body.issue).toMatchObject({
      id: issueId,
      status: "blocked",
    });

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });

  it("stays unlocked after a blocked comment wake gets a 422 checkout and then patches blocked triage", async () => {
    const { companyId, assigneeAgentId, foreignAgentId, issueId } = await seedScenario();
    const run = await startBlockedInteractionWake(assigneeAgentId, issueId, "issue_commented");

    const checkoutRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: assigneeAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(422);
    expect(checkoutRes.body).toMatchObject({
      error: "Issue is blocked by unresolved blockers",
    });

    const patchRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "blocked",
        comment: `Still blocked after checkout triage. [@CEO](agent://${foreignAgentId}) for visibility.`,
      });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const issueRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    const contextRes = await request(createApp(agentActor(companyId, assigneeAgentId, run.id)))
      .get(`/api/issues/${issueId}/heartbeat-context`);
    expect(contextRes.status, JSON.stringify(contextRes.body)).toBe(200);
    expect(contextRes.body.issue).toMatchObject({
      id: issueId,
      status: "blocked",
    });

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.releaseAll();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });

  it("stays unlocked after a blocked foreign mention wake gets a 422 checkout and then posts triage", async () => {
    const { companyId, assigneeAgentId, foreignAgentId, issueId } = await seedScenario();
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: `For visibility: [@CEO](agent://${foreignAgentId})`,
      authorAgentId: assigneeAgentId,
    });
    const run = await startBlockedInteractionWake(foreignAgentId, issueId, "issue_comment_mentioned");

    const checkoutRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: foreignAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(422);
    expect(checkoutRes.body).toMatchObject({
      error: "Issue is blocked by unresolved blockers",
    });

    const commentRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "Triage only. The blockers are still unresolved, so I am not checking this issue out.",
      });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const issueRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.releaseAll();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });

  it("keeps deferred blocked mention wake promotions unlocked", async () => {
    const { assigneeAgentId, issueId } = await seedScenario();
    const firstRun = await startBlockedInteractionWake(assigneeAgentId, issueId, "issue_commented");
    const commentId = randomUUID();

    await db
      .update(issues)
      .set({
        executionRunId: firstRun.id,
        executionAgentNameKey: "qaeng",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    const deferredRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(deferredRun).toBeNull();

    await waitForCondition(async () =>
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, assigneeAgentId))
        .then((rows) => rows.some((row) => row.status === "deferred_issue_execution"))
    );

    adapterControl.release();

    await waitForCondition(async () =>
      db
        .select({
          runId: agentWakeupRequests.runId,
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, assigneeAgentId))
        .then((rows) => rows.some((row) => row.reason === "issue_execution_promoted" && Boolean(row.runId))),
    );

    const promotedWake = await db
      .select({
        runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, assigneeAgentId))
      .then((rows) => rows.find((row) => row.reason === "issue_execution_promoted" && row.runId) ?? null);
    expect(promotedWake?.reason).toBe("issue_execution_promoted");
    expect(["queued", "claimed", "running"]).toContain(promotedWake?.status ?? "");

    const promotedIssueRow = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(promotedIssueRow).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.release();

    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, assigneeAgentId))
        .then((rows) => rows.filter((row) => row.status === "succeeded").length === 2)
    );

    const finalIssueRow = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(finalIssueRow).toEqual({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("keeps cancelled dependency-blocked mention wakes comment-only and unlocked", async () => {
    const { companyId, assigneeAgentId, foreignAgentId, issueId } = await seedScenario("cancelled");
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: `For visibility: [@CEO](agent://${foreignAgentId})`,
      authorAgentId: assigneeAgentId,
    });
    const run = await startBlockedInteractionWake(foreignAgentId, issueId);

    const checkoutRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: foreignAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review", "cancelled"],
      });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(422);
    expect(checkoutRes.body).toMatchObject({
      error: "Issue is blocked by unresolved blockers",
    });

    const commentRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "Acknowledged. The dependency is still unresolved, so I am leaving this cancelled.",
      });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const issueRes = await request(createApp(agentActor(companyId, foreignAgentId, run.id)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "cancelled",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      status: "cancelled",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });

  it("keeps same-assignee comment-only mention wakes unlocked on blocked issues without first-class blockers", async () => {
    const { companyId, assigneeAgentId, issueId } = await seedScenario("blocked", {
      includeBlockerRelation: false,
    });
    const run = await startBlockedInteractionWake(assigneeAgentId, issueId);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const issueRes = await request(createApp(agentActor(companyId, assigneeAgentId)))
      .get(`/api/issues/${issueId}`);
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    expect(issueRes.body).toMatchObject({
      id: issueId,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(issueRes.body).not.toHaveProperty("activeRun");

    adapterControl.release();
    await waitForCondition(async () =>
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0]?.status === "succeeded")
    );
  });
});
