import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat execution-window tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function toClockTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function buildClosedWindow(now: Date) {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return {
    startTime: toClockTime(minuteOfDay + 5),
    endTime: toClockTime(minuteOfDay + 10),
    timeZone: "UTC",
  };
}

describeEmbeddedPostgres("heartbeat execution window policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-window-");
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

async function seedFixture(input: {
    now: Date;
    allowOutsideExecutionWindow?: boolean;
    withIssue?: boolean;
    executionWindow?: { startTime: string; endTime: string; timeZone?: string };
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const executionWindow = input.executionWindow ?? buildClosedWindow(input.now);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NightWorker",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          executionWindow,
        },
      },
      permissions: {},
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input.withIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Execute only overnight",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        allowOutsideExecutionWindow: input.allowOutsideExecutionWindow ?? false,
      });
    }

    return { companyId, agentId, issueId };
  }

  it("skips issue wakeups outside the configured execution window by default", async () => {
    const now = new Date();
    const { companyId, agentId, issueId } = await seedFixture({ now });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      now,
    });

    expect(run).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("heartbeat.executionWindow.inactive");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("allows per-issue override to queue wakeups outside the execution window", async () => {
    const now = new Date();
    const { companyId, agentId, issueId } = await seedFixture({
      now,
      allowOutsideExecutionWindow: true,
    });
    const heartbeat = heartbeatService(db);

    // Occupy the only concurrency slot so we can assert queueing without executing the run.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date("2026-03-19T01:00:00.000Z"),
      contextSnapshot: {},
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      now,
    });

    expect(queued).not.toBeNull();
    expect(queued?.status).toBe("queued");

    const queuedWake = queued?.wakeupRequestId
      ? await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, queued.wakeupRequestId))
          .then((rows) => rows[0] ?? null)
      : null;
    expect(queuedWake?.status).toBe("queued");
    expect(queuedWake?.reason).toBe("issue_assigned");
  });

  it("skips timer scheduler checks outside the execution window without enqueueing timer wakeups", async () => {
    const now = new Date("2026-03-20T12:00:00.000Z");
    const { agentId } = await seedFixture({ now, withIssue: false });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now);
    expect(result).toEqual({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const timerWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.source, "timer")));
    expect(timerWakeups).toHaveLength(0);
  });

  it("keeps deferred issue wakeups pending when execution window is closed at promotion time", async () => {
    const now = new Date();
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    const openWindow = {
      startTime: toClockTime(minuteOfDay - 5),
      endTime: toClockTime(minuteOfDay + 5),
      timeZone: "UTC",
    };
    const { agentId, companyId, issueId } = await seedFixture({
      now,
      executionWindow: openWindow,
    });
    const heartbeat = heartbeatService(db);

    const runningRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(now.getTime() - 45_000),
        contextSnapshot: { issueId },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(issues)
      .set({
        executionRunId: runningRun.id,
        executionAgentNameKey: "nightworker",
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    const deferredWakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId },
        status: "deferred_issue_execution",
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            executionWindow: buildClosedWindow(now),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    await heartbeat.cancelRun(runningRun.id);

    const deferredAfter = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeup.id))
      .then((rows) => rows[0] ?? null);
    expect(deferredAfter?.status).toBe("deferred_issue_execution");
    expect(deferredAfter?.runId).toBeNull();
    expect(deferredAfter?.reason).toBe("issue_execution_deferred");

    const issueAfter = await db
      .select({
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueAfter?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakeups when the execution window reopens", async () => {
    const now = new Date();
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    const openWindow = {
      startTime: toClockTime(minuteOfDay - 5),
      endTime: toClockTime(minuteOfDay + 5),
      timeZone: "UTC",
    };
    const { agentId, companyId, issueId } = await seedFixture({
      now,
      executionWindow: openWindow,
    });
    const heartbeat = heartbeatService(db);

    const runningRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(now.getTime() - 45_000),
        contextSnapshot: { issueId },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(issues)
      .set({
        executionRunId: runningRun.id,
        executionAgentNameKey: "nightworker",
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    const deferredWakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId },
        status: "deferred_issue_execution",
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            executionWindow: buildClosedWindow(now),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    await heartbeat.cancelRun(runningRun.id);

    // Occupy the agent slot so promotion queues the run without immediately executing it.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(now.getTime() - 10_000),
      contextSnapshot: {},
    });

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            executionWindow: openWindow,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    await heartbeat.resumeQueuedRuns();

    const deferredAfter = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeup.id))
      .then((rows) => rows[0] ?? null);
    expect(deferredAfter?.status).toBe("queued");
    expect(deferredAfter?.reason).toBe("issue_execution_promoted");
    expect(deferredAfter?.runId).toBeTruthy();

    const issueAfter = await db
      .select({
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueAfter?.executionRunId).toBe(deferredAfter?.runId ?? null);

    const promotedRun = deferredAfter?.runId
      ? await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, deferredAfter.runId))
          .then((rows) => rows[0] ?? null)
      : null;
    expect(promotedRun?.status).toBe("queued");
  });

  it("does not count skipped timer checks before interval has elapsed", async () => {
    const now = new Date("2026-03-20T12:00:00.000Z");
    const { agentId } = await seedFixture({ now, withIssue: false });
    const heartbeat = heartbeatService(db);

    await db
      .update(agents)
      .set({
        lastHeartbeatAt: new Date(now.getTime() - 5_000),
        updatedAt: new Date(now.getTime() - 5_000),
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeat.tickTimers(now);
    expect(result).toEqual({
      checked: 1,
      enqueued: 0,
      skipped: 0,
    });

    const timerWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.source, "timer")));
    expect(timerWakeups).toHaveLength(0);
  });
});
