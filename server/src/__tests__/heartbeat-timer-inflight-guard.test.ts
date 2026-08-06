import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
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
    `Skipping embedded Postgres heartbeat timer in-flight guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// KEN-6185: a plain heartbeat_timer wake carries no issueId, so the issue
// execution lock in enqueueWakeup never applied to it. A timer tick landing
// while an agent already had a live run started a second concurrent run that
// re-executed the agent's in_progress issue (Morning Briefing double-dispatch
// incident 2026-07-12). Timer wakes must be skipped while any run for the
// agent is queued, running, or scheduled for retry.
describeEmbeddedPostgres("heartbeat timer in-flight guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-inflight-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // A dispatched run may still be flushing completion writes; retry the
    // FK-sensitive deletes until it settles.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(agentRuntimeState);
        await db.delete(companySkills);
        await db.delete(agents);
        await db.delete(companies);
        await db.delete(instanceSettings);
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(overrides: Partial<typeof agents.$inferInsert> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date("2026-07-12T08:00:00.000Z"),
      ...overrides,
    });

    return { companyId, agentId };
  }

  function timerWakeOptions() {
    return {
      source: "timer" as const,
      triggerDetail: "system" as const,
      reason: "heartbeat_timer",
      requestedByActorType: "system" as const,
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
      },
    };
  }

  it.each(["queued", "running", "scheduled_retry"] as const)(
    "skips a timer wake while the agent has a %s run in flight",
    async (inFlightStatus) => {
      const { companyId, agentId } = await insertAgent();
      const inFlightRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: inFlightRunId,
        companyId,
        agentId,
        status: inFlightStatus,
        invocationSource: "assignment",
        triggerDetail: "system",
        responsibleUserId: "responsible-user",
        startedAt: new Date("2026-07-12T08:30:00.000Z"),
      });

      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      const run = await heartbeat.wakeup(agentId, timerWakeOptions());

      expect(run).toBeNull();

      const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(inFlightRunId);

      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .then((rows) => rows[0] ?? null);
      expect(wakeup).toMatchObject({
        status: "skipped",
        reason: "agent_run_in_flight",
      });
      expect(wakeup?.payload).toMatchObject({
        heartbeatSkip: {
          inFlightRunId,
          inFlightRunStatus: inFlightStatus,
        },
      });
    },
  );

  it("tickTimers counts the in-flight skip instead of enqueuing a concurrent run", async () => {
    const { companyId, agentId } = await insertAgent({
      lastHeartbeatAt: new Date("2026-07-12T08:00:00.000Z"),
    });
    const inFlightRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: inFlightRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      responsibleUserId: "responsible-user",
      startedAt: new Date("2026-07-12T08:30:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const tick = await heartbeat.tickTimers(new Date("2026-07-12T08:33:00.000Z"));

    expect(tick).toEqual({ checked: 1, enqueued: 0, skipped: 1 });

    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);

    const wakeup = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "skipped", reason: "agent_run_in_flight" });

    // The skipped tick still advances lastHeartbeatAt so the scheduler does
    // not spam a skipped wakeup row on every subsequent tick of a long run.
    const agentRow = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agentRow?.lastHeartbeatAt?.getTime()).toBeGreaterThan(
      new Date("2026-07-12T08:00:00.000Z").getTime(),
    );
  });

  it("does not block a timer wake on a stale abandoned in-flight run", async () => {
    // Zombie queued/scheduled_retry runs from months ago (KEN-6175) must not
    // starve an agent's timer wakes forever; the guard ignores runs whose
    // updatedAt is older than the staleness bound.
    const { companyId, agentId } = await insertAgent();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "queued",
      invocationSource: "issue_created",
      triggerDetail: "system",
      responsibleUserId: "responsible-user",
      createdAt: new Date("2026-05-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const run = await heartbeat.wakeup(agentId, timerWakeOptions());

    expect(run).not.toBeNull();
    expect(run?.agentId).toBe(agentId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const latest = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      if (latest && latest.status !== "queued" && latest.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const skipped = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "skipped"))
      .orderBy(desc(agentWakeupRequests.createdAt));
    expect(skipped.map((row) => row.reason)).not.toContain("agent_run_in_flight");
  }, 20_000);

  it("does not block a timer wake when the agent's latest run is terminal", async () => {
    const { companyId, agentId } = await insertAgent();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      responsibleUserId: "responsible-user",
      finishedAt: new Date("2026-07-12T08:31:00.000Z"),
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const run = await heartbeat.wakeup(agentId, timerWakeOptions());

    expect(run).not.toBeNull();
    expect(run?.agentId).toBe(agentId);

    // Wait for the spawned process run to settle so afterEach cleanup does not
    // race its completion writes.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const latest = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      if (latest && latest.status !== "queued" && latest.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const skipped = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "skipped"))
      .orderBy(desc(agentWakeupRequests.createdAt));
    expect(skipped.map((row) => row.reason)).not.toContain("agent_run_in_flight");
  });
});
