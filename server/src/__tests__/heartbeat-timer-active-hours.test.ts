import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer active-hours test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer active-hours tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer active hours", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-active-hours-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Timer active-hours test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTimerAgent(heartbeatConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Active Hours Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Windowed Agent",
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
          maxConcurrentRuns: 5,
          ...heartbeatConfig,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function markTimerDue(agentId: string, lastHeartbeatAt: Date) {
    await db
      .update(agents)
      .set({
        lastHeartbeatAt,
        createdAt: new Date(lastHeartbeatAt.getTime() - 60_000),
      })
      .where(eq(agents.id, agentId));
  }

  async function agentSnapshot(agentId: string) {
    const [row] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ?? null;
  }

  async function runCount(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows.length);
  }

  it("enqueues a due timer tick inside the window", async () => {
    const { agentId } = await seedTimerAgent({
      activeHours: { start: "09:00", end: "18:00", timezone: "UTC" },
    });
    const lastHeartbeatAt = new Date("2026-07-15T10:00:00.000Z");
    await markTimerDue(agentId, lastHeartbeatAt);
    const now = new Date("2026-07-15T12:00:00.000Z");

    const tick = await heartbeat.tickTimers(now);

    expect(tick.enqueued).toBeGreaterThanOrEqual(1);
    expect(await runCount(agentId)).toBe(1);
    const snapshot = await agentSnapshot(agentId);
    expect(snapshot?.lastHeartbeatAt?.getTime()).toBe(now.getTime());
  });

  it("skips a due timer tick outside the window without claiming or writing a run", async () => {
    const { agentId } = await seedTimerAgent({
      activeHours: { start: "09:00", end: "18:00", timezone: "UTC" },
    });
    const lastHeartbeatAt = new Date("2026-07-15T10:00:00.000Z");
    await markTimerDue(agentId, lastHeartbeatAt);
    const now = new Date("2026-07-15T22:00:00.000Z");

    const tick = await heartbeat.tickTimers(now);

    expect(tick.enqueued).toBe(0);
    expect(tick.skipped).toBeGreaterThanOrEqual(1);
    expect(await runCount(agentId)).toBe(0);
    const snapshot = await agentSnapshot(agentId);
    expect(snapshot?.lastHeartbeatAt?.getTime()).toBe(lastHeartbeatAt.getTime());
  });

  it("still enqueues comment and on-demand wakes outside the window", async () => {
    const { agentId } = await seedTimerAgent({
      activeHours: { start: "09:00", end: "18:00", timezone: "UTC" },
    });
    const lastHeartbeatAt = new Date("2026-07-15T10:00:00.000Z");
    await markTimerDue(agentId, lastHeartbeatAt);

    const onDemand = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "ping",
      reason: "manual_ping",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    const comment = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(onDemand).not.toBeNull();
    expect(comment).not.toBeNull();
    expect(await runCount(agentId)).toBeGreaterThanOrEqual(1);
    const snapshot = await agentSnapshot(agentId);
    expect(snapshot?.lastHeartbeatAt?.getTime()).toBe(lastHeartbeatAt.getTime());
  });

  it("ticks as before when activeHours is omitted", async () => {
    const { agentId } = await seedTimerAgent({});
    const lastHeartbeatAt = new Date("2026-07-15T10:00:00.000Z");
    await markTimerDue(agentId, lastHeartbeatAt);
    const now = new Date("2026-07-15T22:00:00.000Z");

    const tick = await heartbeat.tickTimers(now);

    expect(tick.enqueued).toBeGreaterThanOrEqual(1);
    expect(await runCount(agentId)).toBe(1);
    const snapshot = await agentSnapshot(agentId);
    expect(snapshot?.lastHeartbeatAt?.getTime()).toBe(now.getTime());
  });
});
