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
  let releaseCurrentRun: (() => void) | null = null;
  let startedResolver: (() => void) | null = null;
  let startedPromise = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });

  const reset = () => {
    releaseCurrentRun = null;
    startedPromise = new Promise<void>((resolve) => {
      startedResolver = resolve;
    });
  };

  return {
    execute: vi.fn(async () => {
      startedResolver?.();
      await new Promise<void>((resolve) => {
        releaseCurrentRun = resolve;
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
    release: () => releaseCurrentRun?.(),
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

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
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
    adapterControl.release();
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((row) => row.status !== "queued" && row.status !== "running");
    }, 10_000);
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

  async function startBlockedInteractionWake(agentId: string, issueId: string) {
    const commentId = randomUUID();
    const run = await heartbeat.wakeup(agentId, {
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
