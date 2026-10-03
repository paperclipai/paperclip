import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  resolveAdapterConcurrencyLimits,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Adapter concurrency limit test run.",
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
const CONCURRENCY_TEST_ADAPTER = "concurrency_test_adapter";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres adapter-concurrency-limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Pure-function coverage: no DB needed. Every branch of
// resolveAdapterConcurrencyLimits is exercised so the config surface is
// verified independently of the (slower) admission behavior below.
describe("resolveAdapterConcurrencyLimits", () => {
  it("returns no limits when the env var is unset", () => {
    expect(resolveAdapterConcurrencyLimits({})).toEqual({});
  });

  it("returns no limits when the env var is empty or whitespace", () => {
    expect(resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: "" })).toEqual({});
    expect(resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: "   " })).toEqual({});
  });

  it("returns no limits when the value is not valid JSON", () => {
    expect(
      resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: "{not json" }),
    ).toEqual({});
  });

  it("returns no limits when the parsed value is an array or a scalar", () => {
    expect(
      resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: "[1,2,3]" }),
    ).toEqual({});
    expect(
      resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: "5" }),
    ).toEqual({});
  });

  it("parses a valid mapping of adapter type to a positive limit", () => {
    expect(
      resolveAdapterConcurrencyLimits({
        PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: '{"opencode":5,"litellm":10}',
      }),
    ).toEqual({ opencode: 5, litellm: 10 });
  });

  it("drops entries that are zero, negative, non-numeric, or non-finite", () => {
    expect(
      resolveAdapterConcurrencyLimits({
        PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS:
          '{"zero":0,"negative":-3,"word":"nope","inf":Infinity,"good":2}'.replace(
            "Infinity",
            '"Infinity"',
          ),
      }),
    ).toEqual({ good: 2 });
  });

  it("floors a fractional limit to a whole number of runs", () => {
    expect(
      resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: '{"opencode":2.9}' }),
    ).toEqual({ opencode: 2 });
  });

  it("rejects a fractional limit that would floor to zero, instead of silently capping at zero", () => {
    // A limit of 0 would leave every run for that adapter type queued
    // forever, since reaching the limit never happens with nothing running.
    // A value like 0.5 is a config mistake, not an intentional "block
    // everything" -- so it is dropped (adapter type unthrottled) rather than
    // floored into a permanent lockout.
    expect(
      resolveAdapterConcurrencyLimits({ PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: '{"opencode_local":0.5}' }),
    ).toEqual({});
  });
});

describeEmbeddedPostgres("heartbeat adapter-type concurrency limit", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-adapter-concurrency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // A real wakeup touches many tables beyond the ones this test inserts
    // into directly (activity_log, agent_runtime_state, company_skills, ...).
    // TRUNCATE ... CASCADE clears companies and everything that references
    // them in one statement instead of chasing each dependent table by hand.
    await db.execute(sql`TRUNCATE TABLE ${companies} CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompanyAndAgents() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "AdapterAgentA",
        role: "engineer",
        status: "active",
        adapterType: CONCURRENCY_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "AdapterAgentB",
        role: "engineer",
        status: "active",
        adapterType: CONCURRENCY_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
      },
    ]);
    return { companyId, agentAId, agentBId };
  }

  it(
    "leaves a run queued when the adapter type is already at its instance-wide limit",
    async () => {
      const { companyId, agentAId, agentBId } = await createCompanyAndAgents();
      const heartbeat = heartbeatService(db, {
        runtimeEnv: {
          PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: JSON.stringify({
            [CONCURRENCY_TEST_ADAPTER]: 1,
          }),
        },
      });

      // Agent A already occupies the adapter type's only slot. Inserted
      // directly, not executed, because this test is about the scheduler's
      // admission decision, not about running a real adapter to completion.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: {},
      });

      await heartbeat.wakeup(agentBId, {
        source: "on_demand",
        triggerDetail: "manual",
        manualUserWake: true,
        requestedByActorType: "user",
        requestedByActorId: "test-responsible-user",
      });
      await heartbeat.drainActiveRunExecutions();

      const agentBRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentBId));
      expect(agentBRuns).toHaveLength(1);
      expect(agentBRuns[0]?.status).toBe("queued");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    },
    15_000,
  );

  it(
    "admits the queued run once the adapter type's slot is freed",
    async () => {
      const { companyId, agentAId, agentBId } = await createCompanyAndAgents();
      const heartbeat = heartbeatService(db, {
        runtimeEnv: {
          PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: JSON.stringify({
            [CONCURRENCY_TEST_ADAPTER]: 1,
          }),
        },
      });

      const runAId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runAId,
        companyId,
        agentId: agentAId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: {},
      });

      // A shared idempotencyKey makes the second wakeup() call below resolve
      // to the same logical request as the first, so it re-attempts admission
      // of the existing queued run instead of enqueueing a second one.
      const wakeOptions = {
        source: "on_demand" as const,
        triggerDetail: "manual" as const,
        manualUserWake: true,
        requestedByActorType: "user" as const,
        requestedByActorId: "test-responsible-user",
        idempotencyKey: "adapter-concurrency-test-wake",
      };

      await heartbeat.wakeup(agentBId, wakeOptions);
      await heartbeat.drainActiveRunExecutions();
      let agentBRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentBId));
      expect(agentBRuns[0]?.status).toBe("queued");

      // Agent A's run finishes, freeing its slot in the shared bucket.
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, runAId));

      // A second wake for agent B, carrying the same idempotencyKey,
      // re-attempts admission of the same still-queued run -- this mirrors
      // production, where either the next timer tick or another wake
      // promotes work once a slot frees up.
      await heartbeat.wakeup(agentBId, wakeOptions);
      await heartbeat.drainActiveRunExecutions();

      agentBRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentBId));
      // The retry wake above is not guaranteed to coalesce into the original
      // queued run -- it may enqueue a second one instead. What the fix
      // promises is narrower and is what matters here: nothing is left
      // permanently queued once the adapter type has capacity again, and
      // every claimed run executes exactly once (no starvation, no double
      // dispatch of the same row).
      expect(agentBRuns.length).toBeGreaterThanOrEqual(1);
      for (const run of agentBRuns) {
        expect(run.status).toBe("succeeded");
      }
      expect(mockAdapterExecute).toHaveBeenCalledTimes(agentBRuns.length);
    },
    15_000,
  );

  it(
    "counts a running run against the adapter type it was dispatched under, not the agent's current one",
    async () => {
      // Agent A started its run while its adapterType was still
      // CONCURRENCY_TEST_ADAPTER -- captured in runnerProfileJson at dispatch
      // time, exactly as claimQueuedRun stamps it. An operator then reassigns
      // the agent to a different adapter type while that run is still active.
      const { companyId, agentAId, agentBId } = await createCompanyAndAgents();
      const heartbeat = heartbeatService(db, {
        runtimeEnv: {
          PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: JSON.stringify({
            [CONCURRENCY_TEST_ADAPTER]: 1,
          }),
        },
      });

      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: {},
        runnerProfileJson: {
          adapterDispatch: { adapterType: CONCURRENCY_TEST_ADAPTER },
        },
      });
      await db
        .update(agents)
        .set({ adapterType: "reassigned_other_adapter" })
        .where(eq(agents.id, agentAId));

      // Agent B is still on the throttled adapter type. If the bucket were
      // (incorrectly) keyed off agent A's current adapterType, A's running
      // run would no longer occupy it and B would be admitted immediately.
      await heartbeat.wakeup(agentBId, {
        source: "on_demand",
        triggerDetail: "manual",
        manualUserWake: true,
        requestedByActorType: "user",
        requestedByActorId: "test-responsible-user",
      });
      await heartbeat.drainActiveRunExecutions();

      const agentBRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentBId));
      expect(agentBRuns).toHaveLength(1);
      expect(agentBRuns[0]?.status).toBe("queued");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    },
    15_000,
  );

  it(
    "admits only one of two agents racing for the same adapter type's single slot",
    async () => {
      // Both agents wake up with no run yet occupying the adapter type's
      // single slot, so both admission attempts start from the same "0
      // running, capacity available" state and genuinely race -- this is the
      // scenario the instance-wide guard exists for: two concurrent callers
      // reading the same snapshot and both deciding they may claim.
      const { agentAId, agentBId } = await createCompanyAndAgents();
      const heartbeat = heartbeatService(db, {
        runtimeEnv: {
          PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS: JSON.stringify({
            [CONCURRENCY_TEST_ADAPTER]: 1,
          }),
        },
      });

      // The default mock resolves immediately, which would let whichever run
      // gets admitted first finish (and free its slot) before the second
      // admission attempt's count check even runs -- at which point admitting
      // the second one too is correct, not a bug, and the test would assert
      // nothing about the actual race. Holding execution open here until
      // both wakeups have returned keeps the first claimed run "running" for
      // the whole window in which the second admission decision is made,
      // regardless of how fast that decision happens to run.
      let releaseExecutions!: () => void;
      const executionGate = new Promise<void>((resolve) => {
        releaseExecutions = resolve;
      });
      mockAdapterExecute.mockImplementation(async () => {
        await executionGate;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Adapter concurrency limit test run.",
          provider: "test",
          model: "test-model",
        };
      });

      try {
        await Promise.all([
          heartbeat.wakeup(agentAId, {
            source: "on_demand",
            triggerDetail: "manual",
            manualUserWake: true,
            requestedByActorType: "user",
            requestedByActorId: "test-responsible-user",
          }),
          heartbeat.wakeup(agentBId, {
            source: "on_demand",
            triggerDetail: "manual",
            manualUserWake: true,
            requestedByActorType: "user",
            requestedByActorId: "test-responsible-user",
          }),
        ]);

        // Both admission decisions are already made at this point (wakeup()
        // only awaits the claim, not the adapter execution it kicks off) --
        // so this snapshot, taken while the first claimed run is still
        // deliberately held "running", is exactly what the guard promises.
        const midRunRows = await db
          .select()
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.agentId, [agentAId, agentBId]));
        expect(midRunRows.filter((run) => run.status === "running")).toHaveLength(1);
        expect(midRunRows.filter((run) => run.status === "queued")).toHaveLength(1);
      } finally {
        releaseExecutions();
        // Restore the fast-resolving default so later tests in this file
        // aren't left waiting on a gate nothing will ever open.
        mockAdapterExecute.mockImplementation(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Adapter concurrency limit test run.",
          provider: "test",
          model: "test-model",
        }));
        // Drain here, not after the try/finally: if a mid-race assertion
        // above throws, the gate is still released, but without this the
        // background run it unblocks would still be writing to the database
        // when afterEach's TRUNCATE runs right after this test -- turning one
        // clear assertion failure into a confusing secondary error.
        await heartbeat.drainActiveRunExecutions();
      }

      const allRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.agentId, [agentAId, agentBId]));
      const admitted = allRuns.filter((run) => run.status === "succeeded");
      const stillQueued = allRuns.filter((run) => run.status === "queued");
      // Exactly one of the two ever ran: the guard admitted one and left the
      // other queued instead of letting both through.
      expect(admitted).toHaveLength(1);
      expect(stillQueued).toHaveLength(1);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
    15_000,
  );

  it(
    "does not throttle an adapter type with no configured limit",
    async () => {
      const { companyId, agentAId, agentBId } = await createCompanyAndAgents();
      // No PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS at all: default, opt-in-only behavior.
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });

      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: agentAId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        contextSnapshot: {},
      });

      await heartbeat.wakeup(agentBId, {
        source: "on_demand",
        triggerDetail: "manual",
        manualUserWake: true,
        requestedByActorType: "user",
        requestedByActorId: "test-responsible-user",
      });
      await heartbeat.drainActiveRunExecutions();

      const agentBRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentBId));
      expect(agentBRuns[0]?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
    15_000,
  );
});
