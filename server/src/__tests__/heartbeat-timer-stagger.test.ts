import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK,
  heartbeatService,
  resolveHeartbeatTimerMaxWakeupsPerTick,
} from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer stagger test run.",
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

describe("resolveHeartbeatTimerMaxWakeupsPerTick", () => {
  it("defaults when the env var is absent or malformed", () => {
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({})).toBe(DEFAULT_HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK);
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({ HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK: "not-a-number" }))
      .toBe(DEFAULT_HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK);
  });

  it("uses an explicit positive cap, flooring fractions", () => {
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({ HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK: "3" })).toBe(3);
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({ HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK: "2.9" })).toBe(2);
  });

  it("treats a non-positive value as an explicit opt-out", () => {
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({ HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK: "0" }))
      .toBe(Number.POSITIVE_INFINITY);
    expect(resolveHeartbeatTimerMaxWakeupsPerTick({ HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK: "-5" }))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer stagger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer stagger (per-tick wakeup cap)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-stagger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env.HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK;
    // Fire-and-forget run executions seed rows across many FK-linked tables
    // (runtime state, skills, leases); cascade from the roots instead of
    // enumerating them.
    await db.execute(sql.raw('TRUNCATE TABLE "companies" CASCADE'));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithDueAgents(agentCount: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stagger Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    const agentIds: string[] = [];
    for (let index = 0; index < agentCount; index += 1) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Due Agent ${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
        // Every agent is overdue, mimicking a host that slept past every
        // heartbeat interval and resumed.
        lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
      });
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `Actionable work ${index}`,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      });
    }

    return { companyId, agentIds };
  }

  it("caps timer wakeups per tick and drains the overdue backlog across ticks", async () => {
    process.env.HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK = "1";
    const { agentIds } = await seedCompanyWithDueAgents(3);
    const heartbeat = heartbeatService(db);

    const firstTick = await heartbeat.tickTimers(new Date());
    expect(firstTick.enqueued).toBe(1);
    expect(firstTick.deferred).toBe(2);

    const secondTick = await heartbeat.tickTimers(new Date());
    expect(secondTick.enqueued).toBe(1);
    expect(secondTick.deferred).toBe(1);

    const thirdTick = await heartbeat.tickTimers(new Date());
    expect(thirdTick.enqueued).toBe(1);
    expect(thirdTick.deferred).toBe(0);

    // Every overdue agent got exactly one timer run — deferral staggers, it
    // never drops or duplicates work.
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, agentIds));
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((run) => run.agentId)).size).toBe(3);
  });

  it("enqueues every due agent in one tick when the backlog fits the cap", async () => {
    process.env.HEARTBEAT_TIMER_MAX_WAKEUPS_PER_TICK = "8";
    const { agentIds } = await seedCompanyWithDueAgents(3);
    const heartbeat = heartbeatService(db);

    const tick = await heartbeat.tickTimers(new Date());
    expect(tick.enqueued).toBe(3);
    expect(tick.deferred).toBe(0);

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, agentIds));
    expect(runs).toHaveLength(3);
  });
});
