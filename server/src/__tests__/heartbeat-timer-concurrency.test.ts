import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  workspaceRuntimeServices,
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
    `Skipping embedded Postgres heartbeat timer concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer concurrency guard (CAR-941)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timer-concurrency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function sideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);
    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await sideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function cleanupRows() {
    await waitForSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts?: { intervalSec?: number; lastHeartbeatAt?: Date }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Acme Corp",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpsManager",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: opts?.intervalSec ?? 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      lastHeartbeatAt: opts?.lastHeartbeatAt ?? null,
    });

    return { companyId, agentId };
  }

  it("skips timer trigger when the agent already has a running issue-scoped run", async () => {
    // Reproduces CAR-941: timer fires while a run is active on an issue (non-null
    // taskKey). isSameTaskScope in enqueueWakeup fails to coalesce because the
    // timer wakeup has null taskKey but the running run has an issue UUID as taskKey
    // — without the concurrency guard in tickTimers, a second run is created.
    const issueId = randomUUID();
    const { agentId, companyId } = await seedAgent({
      lastHeartbeatAt: new Date("2026-06-01T11:58:00.000Z"),
    });

    // Seed a currently-running run that is working on an issue (issue-scoped taskKey)
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        wakeSource: "assignment",
      },
    });

    const heartbeat = heartbeatService(db);
    // 3 minutes after lastHeartbeatAt → 60s interval has elapsed
    const tickAt = new Date("2026-06-01T12:01:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    // No new run should have been created
    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.status).toBe("running");

    // Force the seeded run to terminal so cleanup proceeds without timing out
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.agentId, agentId));
  });

  it("skips timer trigger when the agent has a queued run", async () => {
    const { agentId, companyId } = await seedAgent({
      lastHeartbeatAt: new Date("2026-06-01T11:58:00.000Z"),
    });

    // Seed a queued run (null task scope — prior timer run not yet started)
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      status: "queued",
      contextSnapshot: { wakeSource: "timer" },
    });

    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-06-01T12:01:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(allRuns).toHaveLength(1);

    // Cancel the queued run so cleanup can proceed
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.agentId, agentId));
  });

  it("does enqueue a timer run when no active run exists", async () => {
    const { agentId } = await seedAgent({
      lastHeartbeatAt: new Date("2026-06-01T11:58:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-06-01T12:01:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);

    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.invocationSource).toBe("timer");
  });
});
