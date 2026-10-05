import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { loadConfig } from "../config.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// PAPERCLIP_MAX_CONCURRENT_RUNS bounds concurrent runs across the whole company.
// Unset or 0 must leave dispatch untouched; the cap only refuses to start a run
// when the fleet is already at the ceiling, and the run stays queued for a later
// tick rather than being cancelled.

const { adapterResult, mockAdapterExecute } = vi.hoisted(() => {
  const adapterResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Fleet cap test run.",
    provider: "test",
    model: "test-model",
  };
  return { adapterResult, mockAdapterExecute: vi.fn(async () => ({ ...adapterResult })) };
});

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

describe("fleet concurrency cap config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is disabled when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", undefined);
    expect(loadConfig().maxConcurrentRuns).toBe(0);
  });

  it("is disabled for 0, empty, whitespace, and non-numeric values", () => {
    for (const raw of ["0", "0.4", "", "   ", "soon", "-3"]) {
      vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", raw);
      expect(loadConfig().maxConcurrentRuns).toBe(0);
    }
  });

  it("reads a positive whole number and clamps to the 1..50 range", () => {
    for (const [raw, expected] of [
      ["1", 1],
      ["  5  ", 5],
      ["7.9", 7],
      ["999", 50],
    ] as const) {
      vi.stubEnv("PAPERCLIP_MAX_CONCURRENT_RUNS", raw);
      expect(loadConfig().maxConcurrentRuns).toBe(expected);
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet concurrency cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("fleet concurrency cap dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-fleet-concurrency-cap-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    // mockReset, not mockClear: a test that holds the adapter to keep its runs in
    // flight installs an implementation, and mockClear would leak it forward.
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({ ...adapterResult }));
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(name: string, maxConcurrentRuns = 1) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Fleet Cap ${name}`,
      status: "active",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Fleet Cap Agent ${name}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertAgentInCompany(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Fleet Cap ${name}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return agentId;
  }

  async function insertClaimableRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
    });
    return runId;
  }

  // Keep every dispatched run in flight until the returned release function
  // runs. The default adapter resolves immediately, so its run frees the
  // fleet slot before an assertion can observe it, which both hides the cap
  // and triggers the freed-slot handoff that starts the next queued run.
  function holdAdapter() {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockAdapterExecute.mockImplementation(async () => {
      await held;
      return { ...adapterResult };
    });
    return release;
  }

  function heartbeat(cap?: string) {
    return heartbeatService(db, {
      runtimeEnv: {
        ...process.env,
        PAPERCLIP_MAX_CONCURRENT_RUNS: cap as string | undefined,
      },
    });
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`)
      .then((rows) => rows[0] ?? null);
  }

  // These dispatch tests boot and drive a real adapter run against embedded
  // Postgres, so they use the embedded-Postgres budget rather than the 15s
  // default that the suite config sets for pure in-memory tests.
  it("dispatches normally when the variable is unset", async () => {
    const { companyId, agentId } = await insertAgent("unset");
    // Another agent's run already occupies the fleet; a disabled cap still lets this one start.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: await insertAgentInCompany(companyId, "busy-neighbour"),
      status: "running",
    });
    const runId = await insertClaimableRun(companyId, agentId);

    const service = heartbeat(undefined);
    await service.resumeQueuedRuns();
    await service.drainActiveRunExecutions();

    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dispatches when the fleet is below the cap", async () => {
    const { companyId, agentId } = await insertAgent("below-cap");
    // The occupying run belongs to another agent so the per-agent cap of 1
    // cannot mask the fleet check.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: await insertAgentInCompany(companyId, "busy-neighbour"),
      status: "running",
    });
    const runId = await insertClaimableRun(companyId, agentId);

    const service = heartbeat("2");
    await service.resumeQueuedRuns();
    await service.drainActiveRunExecutions();

    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("leaves the run queued when the fleet is at the cap", async () => {
    const { companyId, agentId } = await insertAgent("at-cap");
    // The occupying run belongs to another agent, so only the fleet cap can
    // refuse this dispatch.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: await insertAgentInCompany(companyId, "busy-neighbour"),
      status: "running",
    });
    const runId = await insertClaimableRun(companyId, agentId);

    await heartbeat("1").resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await runStatus(runId)).toMatchObject({ status: "queued" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("does not count another company's runs against the cap", async () => {
    const mine = await insertAgent("other-company-mine");
    const theirs = await insertAgent("other-company-theirs");
    await db.insert(heartbeatRuns).values({
      companyId: theirs.companyId,
      agentId: theirs.agentId,
      status: "running",
    });
    const runId = await insertClaimableRun(mine.companyId, mine.agentId);

    const service = heartbeat("1");
    await service.resumeQueuedRuns();
    await service.drainActiveRunExecutions();

    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // The claim loop can take more than one run per dispatch. The cap has to
  // bound that batch, not only the admission check that runs before it.
  it("limits one batch to the slots the fleet has left", async () => {
    const { companyId, agentId } = await insertAgent("batch-limit", 5);
    const runIds = [
      await insertClaimableRun(companyId, agentId),
      await insertClaimableRun(companyId, agentId),
      await insertClaimableRun(companyId, agentId),
    ];

    const service = heartbeat("2");
    const release = holdAdapter();
    await service.resumeQueuedRuns();

    // Two of three start. The third stays queued for a later tick; nothing is
    // cancelled and the fleet never runs more than the cap allows. The two
    // started runs are still in flight here, so the count they hold is real.
    const statuses = await Promise.all(runIds.map(runStatus));
    expect(statuses.filter((row) => row?.status === "running")).toHaveLength(2);
    expect(statuses.filter((row) => row?.status === "queued")).toHaveLength(1);

    release();
    await service.drainActiveRunExecutions();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // The per-agent lock is keyed by agent, so two agents in one company can both
  // read the last slot. The company lock makes the count and the claim one
  // operation for every agent in the company.
  it("gives the last slot to one of two agents dispatching at once", async () => {
    const { companyId, agentId: firstAgentId } = await insertAgent("race-first");
    const secondAgentId = await insertAgentInCompany(companyId, "race-second");
    const firstRunId = await insertClaimableRun(companyId, firstAgentId);
    const secondRunId = await insertClaimableRun(companyId, secondAgentId);

    const service = heartbeat("1");
    const release = holdAdapter();
    await Promise.all([
      service.startNextQueuedRunForAgent(firstAgentId),
      service.startNextQueuedRunForAgent(secondAgentId),
    ]);

    // One slot, one run. Which agent wins the company lock is not deterministic,
    // so assert the invariant rather than a specific winner: exactly one run is
    // in flight and the other is still queued behind the cap.
    const statuses = [await runStatus(firstRunId), await runStatus(secondRunId)];
    expect(statuses.filter((row) => row?.status === "running")).toHaveLength(1);
    expect(statuses.filter((row) => row?.status === "queued")).toHaveLength(1);

    release();
    await service.drainActiveRunExecutions();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // A freed slot belongs to whoever in the company is queued, not only to the
  // agent whose run finished. resumeQueuedRuns only runs while scheduled
  // heartbeats are on, so completion retries the company itself.
  it("hands a freed slot to another agent that was waiting on the cap", async () => {
    const { companyId, agentId: firstAgentId } = await insertAgent("slot-handoff-first");
    const secondAgentId = await insertAgentInCompany(companyId, "slot-handoff-second");
    const blockedRunId = await insertClaimableRun(companyId, secondAgentId);
    const firstRunId = await insertClaimableRun(companyId, firstAgentId);

    const service = heartbeat("1");
    await service.startNextQueuedRunForAgent(firstAgentId);
    await service.drainActiveRunExecutions();

    // The first agent's run finished and released the company slot, so the run
    // that was queued behind the cap starts without another wakeup.
    expect(await runStatus(firstRunId)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(blockedRunId)).toMatchObject({ status: "succeeded" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});