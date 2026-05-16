import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeWithEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.todo;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat pause gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeWithEmbeddedPostgres("heartbeat enqueue pause gates", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-pause-gates-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBaseFixture(agentStatus: "active" | "paused" = "active", autoPaused = false) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-23T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        ...(autoPaused ? { autoPause: { paused: true, reason: "runaway_detected", triggeredAt: now.toISOString() } } : {}),
      },
      permissions: {},
    });

    return { companyId, agentId, now };
  }

  async function seedScheduledRetryRun(companyId: string, agentId: string, dueAt: Date) {
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const createdAt = new Date("2026-04-23T09:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: createdAt,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: createdAt,
      createdAt,
    });

    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: dueAt,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: createdAt,
      createdAt,
    });

    return { sourceRunId, retryRunId };
  }

  async function setSystemPaused(paused: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({
      general: paused ? { _systemPaused: true, _systemPausedAt: new Date().toISOString() } : {},
    });
  }

  it("promoteDueScheduledRetries: does not promote when system is paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture();
    const dueAt = new Date(now.getTime() - 1000);
    const { retryRunId } = await seedScheduledRetryRun(companyId, agentId, dueAt);
    await setSystemPaused(true);

    const result = await heartbeat.promoteDueScheduledRetries(now);

    expect(result).toEqual({ promoted: 0, runIds: [] });
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
  });

  it("promoteDueScheduledRetries: does not promote when agent is manually paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture("paused");
    const dueAt = new Date(now.getTime() - 1000);
    const { retryRunId } = await seedScheduledRetryRun(companyId, agentId, dueAt);

    const result = await heartbeat.promoteDueScheduledRetries(now);

    expect(result).toEqual({ promoted: 0, runIds: [] });
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
  });

  it("promoteDueScheduledRetries: does not promote when agent is auto-paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture("active", true);
    const dueAt = new Date(now.getTime() - 1000);
    const { retryRunId } = await seedScheduledRetryRun(companyId, agentId, dueAt);

    const result = await heartbeat.promoteDueScheduledRetries(now);

    expect(result).toEqual({ promoted: 0, runIds: [] });
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
  });

  it("promoteDueScheduledRetries: promotes normally when no pause is active", async () => {
    const { companyId, agentId, now } = await seedBaseFixture();
    const dueAt = new Date(now.getTime() - 1000);
    const { retryRunId } = await seedScheduledRetryRun(companyId, agentId, dueAt);

    const result = await heartbeat.promoteDueScheduledRetries(now);

    expect(result.promoted).toBe(1);
    expect(result.runIds).toContain(retryRunId);
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId)).then((r) => r[0]);
    expect(run?.status).toBe("queued");
  });

  it("scheduleBoundedRetry: returns skipped_paused when system is paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture();
    await setSystemPaused(true);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const result = await heartbeat.scheduleBoundedRetry(runId, { now });
    expect(result.outcome).toBe("skipped_paused");

    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(0);
  });

  it("scheduleBoundedRetry: returns skipped_paused when agent is manually paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture("paused");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const result = await heartbeat.scheduleBoundedRetry(runId, { now });
    expect(result.outcome).toBe("skipped_paused");
  });

  it("scheduleBoundedRetry: returns skipped_paused when agent is auto-paused", async () => {
    const { companyId, agentId, now } = await seedBaseFixture("active", true);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const result = await heartbeat.scheduleBoundedRetry(runId, { now });
    expect(result.outcome).toBe("skipped_paused");
  });
});
