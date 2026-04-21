import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentServiceHealthService } from "../services/agent-service-health.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NOW = new Date("2026-04-19T12:00:00.000Z");

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service health tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `H${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function insertCompanyAgent(
  db: ReturnType<typeof createDb>,
  input: {
    heartbeatEnabled?: boolean;
    intervalSec?: number;
    status?: string;
    companyName?: string;
    agentName?: string;
  } = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: input.companyName ?? "Paperclip",
    issuePrefix: issuePrefix(companyId),
    status: "active",
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: input.agentName ?? "CEO",
    role: "ceo",
    status: input.status ?? "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        enabled: input.heartbeatEnabled ?? true,
        intervalSec: input.intervalSec ?? 300,
      },
    },
    permissions: {},
  });

  return { companyId, agentId };
}

async function insertRun(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId: string;
    status: string;
    createdAt?: Date;
    finishedAt?: Date | null;
    error?: string | null;
    errorCode?: string | null;
  },
) {
  await db.insert(heartbeatRuns).values({
    id: randomUUID(),
    companyId: input.companyId,
    agentId: input.agentId,
    invocationSource: "timer",
    triggerDetail: "system",
    status: input.status,
    createdAt: input.createdAt ?? NOW,
    startedAt: input.status === "queued" ? null : input.createdAt ?? NOW,
    finishedAt: input.finishedAt ?? (input.status === "queued" || input.status === "running" ? null : NOW),
    error: input.error ?? null,
    errorCode: input.errorCode ?? null,
  });
}

async function insertReviewIssue(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId?: string | null;
    updatedAt?: Date;
    executionPolicy?: Record<string, unknown> | null;
    executionState?: Record<string, unknown> | null;
    identifier?: string;
  },
) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId: input.companyId,
    title: "Review implementation handoff",
    status: "in_review",
    boardPosition: 0,
    priority: "medium",
    assigneeAgentId: input.agentId ?? null,
    executionPolicy: input.executionPolicy ?? null,
    executionState: input.executionState ?? null,
    identifier: input.identifier ?? `HEALTH-${issueId.slice(0, 8)}`,
    issueNumber: 1,
    createdAt: input.updatedAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
  });
  return issueId;
}

async function insertWakeupRequest(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
  },
) {
  await db.insert(agentWakeupRequests).values({
    id: randomUUID(),
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    reason: "issue_commented",
    payload: { issueId: input.issueId },
    status: input.status ?? "queued",
    requestedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function createRouteApp(
  db: ReturnType<typeof createDb>,
  actor: Record<string, unknown>,
  opts: { heartbeatSchedulerEnabled?: boolean; heartbeatSchedulerIntervalMs?: number } = {},
) {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../services/agent-service-health.js");
  vi.doUnmock("../services/index.js");
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", agentRoutes(db, opts));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("agent service health", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-service-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns healthy when scheduler-active agents have recent healthy runs", async () => {
    const { companyId, agentId } = await insertCompanyAgent(db);
    await insertRun(db, { companyId, agentId, status: "succeeded" });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("healthy");
    expect(health.reason).toBeNull();
    expect(health.counts.schedulerActiveAgentCount).toBe(1);
  });

  it("reports scheduler_disabled when eligible agents exist but the global scheduler is off", async () => {
    await insertCompanyAgent(db);

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("scheduler_disabled");
  });

  it("reports no_scheduler_active_agents when eligible agents have no enabled timer heartbeats", async () => {
    await insertCompanyAgent(db, { heartbeatEnabled: false, intervalSec: 0 });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("no_scheduler_active_agents");
    expect(health.counts.eligibleAgentCount).toBe(1);
    expect(health.counts.schedulerActiveAgentCount).toBe(0);
  });

  it("reports queued_runs_stuck when queued runs are older than five minutes", async () => {
    const { companyId, agentId } = await insertCompanyAgent(db);
    await insertRun(db, {
      companyId,
      agentId,
      status: "queued",
      createdAt: new Date(NOW.getTime() - 6 * 60 * 1000),
      finishedAt: null,
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("queued_runs_stuck");
    expect(health.counts.stuckQueuedRunCount).toBe(1);
  });

  it("does not report queued_runs_stuck when an old queued run is waiting behind a same-agent running run", async () => {
    const { companyId, agentId } = await insertCompanyAgent(db);
    await insertRun(db, {
      companyId,
      agentId,
      status: "queued",
      createdAt: new Date(NOW.getTime() - 6 * 60 * 1000),
      finishedAt: null,
    });
    await insertRun(db, {
      companyId,
      agentId,
      status: "running",
      createdAt: NOW,
      finishedAt: null,
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("healthy");
    expect(health.reason).toBeNull();
    expect(health.counts.liveRunCount).toBe(2);
    expect(health.counts.stuckQueuedRunCount).toBe(0);
  });

  it("reports queued_runs_stuck when only a different agent is running", async () => {
    const queued = await insertCompanyAgent(db, { agentName: "CTO" });
    const running = await insertCompanyAgent(db, { agentName: "CEO" });
    await insertRun(db, {
      ...queued,
      status: "queued",
      createdAt: new Date(NOW.getTime() - 6 * 60 * 1000),
      finishedAt: null,
    });
    await insertRun(db, {
      ...running,
      status: "running",
      createdAt: NOW,
      finishedAt: null,
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("queued_runs_stuck");
    expect(health.counts.liveRunCount).toBe(2);
    expect(health.counts.stuckQueuedRunCount).toBe(1);
  });

  it("reports recent_runtime_failures when scheduled agents cannot start", async () => {
    const first = await insertCompanyAgent(db, { companyName: "AI Second Brain", agentName: "CEO" });
    const second = await insertCompanyAgent(db, { companyName: "CodeSM MaaS", agentName: "CTO" });
    await insertRun(db, {
      ...first,
      status: "failed",
      error: 'Command not found in PATH: "codex"',
      errorCode: "adapter_failed",
    });
    await insertRun(db, {
      ...second,
      status: "failed",
      error: "Process lost -- child pid 123 is no longer running",
      errorCode: "process_lost",
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("recent_runtime_failures");
    expect(health.counts.recentRuntimeFailureAgentCount).toBe(2);
    expect(health.failureExamples).toHaveLength(2);
  });

  it("does not report down for one failed run when another scheduled agent is healthy", async () => {
    const failed = await insertCompanyAgent(db, { agentName: "CEO" });
    const healthy = await insertCompanyAgent(db, { agentName: "CTO" });
    await insertRun(db, {
      ...failed,
      status: "failed",
      error: 'Command not found in PATH: "codex"',
      errorCode: "adapter_failed",
    });
    await insertRun(db, {
      ...healthy,
      status: "succeeded",
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("healthy");
    expect(health.reason).toBeNull();
    expect(health.counts.recentRuntimeFailureAgentCount).toBe(1);
    expect(health.counts.recentHealthyRunCount).toBe(1);
  });

  it("does not report down for cutover-style process loss when the same scheduled agent is running again", async () => {
    const agent = await insertCompanyAgent(db, { agentName: "CEO" });
    await insertRun(db, {
      ...agent,
      status: "failed",
      error: "Process lost -- server may have restarted",
      errorCode: "process_lost",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 1000),
      finishedAt: new Date(NOW.getTime() - 60 * 1000),
    });
    await insertRun(db, {
      ...agent,
      status: "running",
      createdAt: NOW,
      finishedAt: null,
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("healthy");
    expect(health.reason).toBeNull();
    expect(health.counts.recentRuntimeFailureAgentCount).toBe(1);
    expect(health.counts.recentHealthyRunCount).toBe(1);
  });

  it("flags stale in-review issues without execution state or pending wakeups", async () => {
    const { companyId, agentId } = await insertCompanyAgent(db);
    await insertRun(db, { companyId, agentId, status: "succeeded" });
    const issueId = await insertReviewIssue(db, {
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 16 * 60 * 1000),
      identifier: "HEALTH-1",
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("down");
    expect(health.reason).toBe("stale_in_review_issues");
    expect(health.counts.staleInReviewIssueCount).toBe(1);
    expect(health.boardIssueWarnings).toEqual([
      expect.objectContaining({
        issueId,
        identifier: "HEALTH-1",
        message: "manual review or status correction needed",
      }),
    ]);
  });

  it("does not flag recent, execution-managed, or wakeup-backed in-review issues", async () => {
    const { companyId, agentId } = await insertCompanyAgent(db);
    await insertRun(db, { companyId, agentId, status: "succeeded" });
    await insertReviewIssue(db, {
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 14 * 60 * 1000),
      identifier: "RECENT-1",
    });
    await insertReviewIssue(db, {
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 16 * 60 * 1000),
      executionState: { status: "pending" },
      identifier: "EXEC-1",
    });
    const wakeupBackedIssueId = await insertReviewIssue(db, {
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 16 * 60 * 1000),
      identifier: "WAKE-1",
    });
    await insertWakeupRequest(db, {
      companyId,
      agentId,
      issueId: wakeupBackedIssueId,
    });

    const health = await agentServiceHealthService(db).get({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
      now: NOW,
    });

    expect(health.status).toBe("healthy");
    expect(health.reason).toBeNull();
    expect(health.counts.staleInReviewIssueCount).toBe(0);
    expect(health.boardIssueWarnings).toEqual([]);
  });

  it("requires instance admin access on the route", async () => {
    const app = await createRouteApp(db, {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/agent-service-health");

    expect(res.status).toBe(403);
  });

  it("returns the typed route summary for instance admins", async () => {
    await insertCompanyAgent(db, { heartbeatEnabled: false, intervalSec: 0 });
    const app = await createRouteApp(db, {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    }, {
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30_000,
    });

    const res = await request(app).get("/api/instance/agent-service-health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "down",
      reason: "no_scheduler_active_agents",
      scheduler: {
        enabled: true,
        intervalMs: 30_000,
      },
    });
  });
});
