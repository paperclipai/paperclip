import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  FALSE_LIVENESS_ERROR_REASON,
  FALSE_LIVENESS_SCAN_LIMIT,
  FALSE_LIVENESS_STREAK_THRESHOLD,
} from "../services/run-liveness.ts";

/**
 * The false-liveness detector's WRITE, not its predicate (ALM-6138).
 *
 * `false-liveness-detector.test.ts` pins the pure functions. Nothing pinned the
 * caller in `finalizeAgentStatus`, so six mutations of that call site — an
 * unconditional escalation, an unscoped window, a reversed window, a narrowed
 * window, a discarded reason, and deleting the branch outright — all left the
 * suite green (ADR-004 control 1, findings N1 and H2b on ALM-8037). These
 * fixtures run the real thing end to end against Postgres: seed an agent's run
 * history, execute one real succeeded run through `invoke`, then read what
 * landed on the agent row.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres false-liveness finalize tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// A provider that reported nothing. Copied from a real GeminiEng row.
const DEAD_USAGE = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  rawInputTokens: 0,
  rawOutputTokens: 0,
  rawCachedInputTokens: 0,
};

// An ordinary billed run.
const HEALTHY_USAGE = {
  costUsd: 0.3948814,
  inputTokens: 104000,
  outputTokens: 6379,
  rawInputTokens: 104000,
  rawOutputTokens: 6379,
  rawCachedInputTokens: 98000,
};

/** `null` means the run recorded no usage at all: skipped, not counted. */
type SeedUsage = Record<string, unknown> | null;

describeEmbeddedPostgres("false-liveness detector writes agent status", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "false-liveness-finalize-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("false-liveness-finalize-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    // A run reaches its terminal status before finalizeRun finishes writing its
    // trailing side effects, so drain before truncating or a late write hits a
    // deleted company row.
    await heartbeat.drainActiveRunExecutions();
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  interface CreateAgentOptions {
    /** Seeds the agent mid-fault. `error` is an INVOKABLE status, so a tripped
     * agent keeps running and keeps reaching this write — that is the only
     * reason recovery is possible at all. */
    status?: "idle" | "error";
    errorReason?: string;
    /** Raised above 1 only when a fixture seeds a concurrent in-flight run:
     * `startNextQueuedRunForAgent` gates on `maxConcurrentRuns - runningCount`,
     * so at the default of 1 the seeded row would starve the run under test. */
    maxConcurrentRuns?: number;
    /** Non-zero makes the run FAIL, which is the only way to reach this write
     * with a base status of `error` and a real `failureReason` in hand. */
    exitCode?: number;
  }

  /** An agent whose runs exit 0 immediately: a clean success, every time. */
  async function createAgent(
    companyId: string,
    name: string,
    options: CreateAgentOptions = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: options.status ?? "idle",
      errorReason: options.errorReason ?? null,
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", `process.exit(${options.exitCode ?? 0})`],
      },
      runtimeConfig:
        options.maxConcurrentRuns === undefined
          ? {}
          : { heartbeat: { maxConcurrentRuns: options.maxConcurrentRuns } },
      permissions: {},
    });
    return agentId;
  }

  /**
   * Another of this agent's runs, still in flight.
   *
   * Only the `running` status is load-bearing: `countRunningRunsForAgent`
   * counts rows, not live processes, and that count is what drives `baseStatus`
   * to `running` in the write under test.
   */
  async function seedInFlightRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      startedAt: new Date(),
    });
    return runId;
  }

  /**
   * Seed succeeded history, newest first. `startedAt` is what the detector
   * orders on, so index 0 is the most recent run and each later entry is a
   * minute older.
   */
  async function seedHistory(
    companyId: string,
    agentId: string,
    usagesNewestFirst: readonly SeedUsage[],
    options: { newestMinutesAgo?: number } = {},
  ) {
    const newestMinutesAgo = options.newestMinutesAgo ?? 1;
    const now = Date.now();
    for (const [index, usage] of usagesNewestFirst.entries()) {
      const startedAt = new Date(now - (newestMinutesAgo + index) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        startedAt,
        finishedAt: startedAt,
        usageJson: usage,
      });
    }
  }

  /** Run one real heartbeat to completion and return the finalized agent row. */
  async function runOnceAndReadAgent(
    agentId: string,
    expectedRunStatus: "succeeded" | "failed" = "succeeded",
  ) {
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const deadline = Date.now() + 20_000;
    let run = await heartbeat.getRun(queued!.id);
    while (Date.now() < deadline && run && ["queued", "running"].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await heartbeat.getRun(queued!.id);
    }
    // Asserted, not assumed: a fixture that means to exercise the `failed`
    // outcome and silently gets `succeeded` would read as a passing test of the
    // cell it was written to cover.
    expect(run?.status).toBe(expectedRunStatus);

    // Load-bearing for the window arithmetic below: the run just finalized is
    // itself in the detector's window. A process agent reports no provider
    // usage, so it is SKIPPED — it neither extends nor resets the streak.
    expect(run?.usageJson ?? null).toBeNull();

    // The agent write happens in finalizeAgentStatus, after the run reaches its
    // terminal status. Drain before reading or this races the write under test.
    await heartbeat.drainActiveRunExecutions();

    return readAgent(agentId);
  }

  async function readAgent(agentId: string) {
    return db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
  }

  /**
   * Interrupt one in-flight run the way a graceful shutdown does, and return
   * the finalized agent row.
   *
   * Reaches `finalizeAgentStatus(..., "interrupted", ...)`, which is a real
   * production call site and one of the two non-`succeeded` outcomes that still
   * resolve to a base status of `idle`. Driven from a seeded row rather than a
   * live child process on purpose: `drainRunningRunsForShutdown` selects on the
   * `running` STATUS, and the write under test reads the agent's run history
   * and the outcome — never a pid. Interrupting a real process here would also
   * enqueue a process-loss retry that the dying run's own teardown promotes,
   * which is a second run this fixture has no use for.
   */
  async function interruptOnceAndReadAgent(companyId: string, agentId: string) {
    const runId = await seedInFlightRun(companyId, agentId);

    const drained = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date(),
      [runId],
    );
    expect(drained.interruptedRunIds).toEqual([runId]);
    expect((await heartbeat.getRun(runId))?.status).toBe("interrupted");

    await heartbeat.drainActiveRunExecutions();

    return readAgent(agentId);
  }

  /**
   * Cancel one in-flight run, and return the finalized agent row.
   *
   * The twin of the helper above, and worth having separately: `cancelled` is
   * the OTHER non-`succeeded` outcome that resolves to a base status of `idle`,
   * and it reaches `finalizeAgentStatus` from different call sites than a
   * shutdown drain does. Seeded the same way and for the same reason.
   */
  async function cancelOnceAndReadAgent(companyId: string, agentId: string) {
    const runId = await seedInFlightRun(companyId, agentId);

    await heartbeat.cancelRun(runId);
    expect((await heartbeat.getRun(runId))?.status).toBe("cancelled");

    await heartbeat.drainActiveRunExecutions();

    return readAgent(agentId);
  }

  const dead = (n: number): SeedUsage[] => Array.from({ length: n }, () => ({ ...DEAD_USAGE }));
  const healthy = (n: number): SeedUsage[] =>
    Array.from({ length: n }, () => ({ ...HEALTHY_USAGE }));
  const unrecorded = (n: number): SeedUsage[] => Array.from({ length: n }, () => null);

  it("marks the agent unavailable on a full zero-usage streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadAdapter");
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The reason is asserted by equality, not presence: `class-b-dry-run` §D's
    // bulk undo keys on these exact bytes, and dropping the detector's reason
    // in favour of the caller's `failureReason` (null here) is otherwise
    // invisible.
    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("leaves the agent idle when a healthy run breaks the streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "RecoveredAdapter");
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("reads the agent's newest runs, not its oldest", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "RecoveredFromOldOutage");
    // A finished outage: a full streak of zero-usage runs, then healthy ones.
    // Reversing the window's sort order reads the old block forever, so a
    // tripped agent could never recover.
    await seedHistory(companyId, agentId, [
      ...healthy(2),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("scopes the streak to one agent, not the whole company", async () => {
    const companyId = await createCompany();
    const healthyAgentId = await createAgent(companyId, "HealthyAgent");
    const deadAgentId = await createAgent(companyId, "DeadSibling");

    // The sibling's zero-usage runs are the NEWEST rows in the company, so an
    // unscoped window would read them as the healthy agent's own streak.
    await seedHistory(companyId, healthyAgentId, healthy(1), { newestMinutesAgo: 30 });
    await seedHistory(companyId, deadAgentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    expect(await runOnceAndReadAgent(healthyAgentId)).toEqual({
      status: "idle",
      errorReason: null,
    });

    // And the sibling is untouched by a run it did not take part in.
    const sibling = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, deadAgentId))
      .then((rows) => rows[0]!);
    expect(sibling.status).toBe("idle");
  });

  it("looks past skipped runs to find the streak", async () => {
    expect(FALSE_LIVENESS_SCAN_LIMIT).toBeGreaterThan(FALSE_LIVENESS_STREAK_THRESHOLD);

    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "GapThenDeath");
    // Enough unrecorded runs that — with the live run, which is also
    // unrecorded — they exactly fill a THRESHOLD-sized window. Reading only
    // THRESHOLD rows would see nothing but skips and never reach the streak
    // behind them, which is why the scan limit is a multiple of the threshold.
    await seedHistory(companyId, agentId, [
      ...unrecorded(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  // The three fixtures below pin the `running` carve-out and the two
  // non-`succeeded` outcomes SEPARATELY (ALM-8333 / ADR-004 Amendment 6). Every
  // fixture above finalizes a succeeded run on an agent with nothing else in
  // flight, so each one enters the same cell, and the carve-out could be
  // deleted with the suite still green.

  it("leaves a concurrently-running agent's STATUS alone, but still records the fault", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadButBusy", {
      maxConcurrentRuns: 2,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));
    // The agent's OTHER run, still executing. Overwriting `running` with
    // `error` would publish a status against an agent that is mid-run, so the
    // status is left alone — but the REASON is written now rather than deferred
    // to some later finalization. Deferring it is what stranded a tripped agent
    // at `{idle, null}` (ALM-9552): the run that would have carried the marker
    // forward has to find a marker already there, and until this branch writes
    // one there is nothing to find.
    await seedInFlightRun(companyId, agentId);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "running",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("never advertises a tripped agent as healthy across a busy run and its cancel", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadBusyThenCancelled", {
      maxConcurrentRuns: 2,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));
    const siblingRunId = await seedInFlightRun(companyId, agentId);

    // The ALM-9552 sequence, in order, each step an ordinary production path
    // and no race anywhere in it. At `f4606acb4` this ran
    // `{running, null}` -> `{idle, null}` -> `{error, FAULT}`: the succeeded
    // finalization declined to decide because a sibling was in flight, the
    // sibling's cancel declined because `cancelled` is not `succeeded`, and
    // between them a streak-5 agent was published as healthy. Neither
    // finalization had written the marker, so there was nothing to carry.
    //
    // Reach: any agent with `maxConcurrentRuns > 1` whose succeeded run
    // finalizes beside an in-flight sibling that then ends non-`succeeded`.
    // `cancelled` arrives from the workspace-busy deferral path in ordinary
    // scheduling; `interrupted` arrives from every deploy.
    //
    // Both single-step fixtures above would stay green if the middle step
    // regressed — each observes one write, and this defect is only visible
    // across two.
    const afterSucceeded = await runOnceAndReadAgent(agentId);

    await heartbeat.cancelRun(siblingRunId);
    expect((await heartbeat.getRun(siblingRunId))?.status).toBe("cancelled");
    await heartbeat.drainActiveRunExecutions();
    const afterCancel = await readAgent(agentId);

    const afterNextSucceeded = await runOnceAndReadAgent(agentId);

    // Asserted as a sequence, not three independent reads: the status is never
    // `idle` and the reason is never dropped at any point along it.
    expect([afterSucceeded, afterCancel, afterNextSucceeded]).toEqual([
      { status: "running", errorReason: FALSE_LIVENESS_ERROR_REASON },
      { status: "error", errorReason: FALSE_LIVENESS_ERROR_REASON },
      { status: "error", errorReason: FALSE_LIVENESS_ERROR_REASON },
    ]);
  });

  it("escalates on an interrupted finalization when the streak already holds", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadButInterrupted");
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The interrupt is not the evidence — the five persisted zero-usage
    // SUCCEEDED runs are, and `falseLivenessStreak` skips the interrupted row
    // itself. So this escalates on a restart only for an agent that already met
    // the trip condition before the restart, which is the agent the detector
    // exists to find. A healthy agent interrupted by the same deploy computes a
    // streak of 0 and is untouched — `leaves an interrupted healthy agent
    // alone` below is that case.
    //
    // This inverted at ALM-9552. It previously asserted `{idle, null}` on the
    // argument that a killed run makes no claim of success; true, and beside
    // the point, because the finalizing run's outcome is not what the streak is
    // computed from. Leaving it uninverted is what let a tripped agent reach
    // `{idle, null}` with the fault never written at all.
    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("escalates on a cancelled finalization when the streak already holds", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadButCancelled");
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The fixture above names `cancelled` and then tests only `interrupted`,
    // which left the `cancelled` arm admitted by no fixture (AdversarialEng A2,
    // ALM-9520). Each outcome still needs its own example.
    //
    // `cancelled` matters more than `interrupted` here: it reaches
    // `finalizeAgentStatus` from the workspace-busy deferral path, which fires
    // in ordinary scheduling rather than once per shutdown. It is also step 2
    // of the ALM-9552 sequence — the finalization that used to drop a tripped
    // agent to `idle`.
    expect(await cancelOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("leaves an interrupted healthy agent alone", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "HealthyButInterrupted");
    // One healthy run at the head breaks the streak, so the detector has no
    // finding. Without this, widening the escalation to fire on ANY
    // interrupted finalization — the failure mode the two fixtures above would
    // otherwise invite — is green, and every deploy would mark the whole fleet
    // unavailable.
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  // And these two pin the recovery write, by varying the agent's PRIOR status
  // rather than the finalizing run (ALM-8333 BLOCKING-2). Every fixture above
  // seeds `idle`, so the transition out of the fault is never exercised.

  it("clears the fault when the adapter starts reporting usage again", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFixed", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    // Credentials repaired: the newest run billed real tokens, so the streak is
    // broken and this agent is owed its `idle` back.
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("keeps a tripped agent in the fault while the streak still holds", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedAndStillDead", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The twin of the fixture above, and the reason it cannot be satisfied by
    // simply never re-escalating an agent that already carries this reason:
    // skipping the escalation would drop `nextStatus` back to `idle` and the
    // reason to `null`, so re-asserting the fault IS what keeps a still-dead
    // agent from being handed more work.
    //
    // This covers one finalization only — a succeeded run with nothing else in
    // flight. Every other finalization is the group below.
    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  // And this group pins the HOLD (ALM-9523): what the write does on a
  // finalization that is not entitled to decide the fault at all. The three
  // fixtures above enter the one cell where the escalation runs, so the fault
  // was re-asserted there and silently dropped everywhere else — measured at
  // `cb53af60b`, `interrupted` and `cancelled` both reset a tripped agent to
  // `{idle, null}` while its streak still held, and a concurrent run reset it
  // to `{running, null}`.

  it("holds the fault across an interrupted finalization", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenInterrupted", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The production trigger, and the reason this is not a corner case: a
    // graceful shutdown drains every in-flight run as `interrupted`, and
    // `error` is an INVOKABLE status, so a tripped agent keeps taking runs and
    // keeps having one in flight. Every deploy cleared every tripped agent.
    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("holds the fault across a cancelled finalization", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenCancelled", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // One variable apart from the fixture above. `cancelled` reaches the same
    // `idle` disjunct of `baseStatus` by a different outcome and through
    // different call sites, so an outcome-by-outcome fix could close one and
    // leave the other; this pins that the condition is the evidence, not a
    // list of outcomes.
    expect(await cancelOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("holds the fault while another of the agent's runs is in flight", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedAndBusy", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
      maxConcurrentRuns: 2,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));
    await seedInFlightRun(companyId, agentId);

    // One variable apart from `leaves a concurrently-running agent alone`,
    // which seeds `idle`: here the agent is already tripped, so suppressing the
    // escalation is not enough — the reason has to survive too. `running` with
    // a reason set is not a novel state; it is exactly how a tripped agent
    // looks mid-run, because the run-start write flips the status and leaves
    // `errorReason` alone.
    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "running",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("does not clear the fault on an interrupted run that broke the streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFixedThenKilled", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    // Credentials repaired — the same history that DOES clear the fault in
    // `clears the fault when the adapter starts reporting usage again`.
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    // The repair takes effect on this finalization rather than outliving it by
    // one run. The interrupt is still not the evidence — the healthy SUCCEEDED
    // run at the head of the history is, and it is the same row that clears the
    // fault through `clears the fault when the adapter starts reporting usage
    // again`.
    //
    // This inverted at ALM-9552, and the asymmetry its old comment warned about
    // is what went away. Reading history on the recovery path used to be wider
    // than the escalation path, which is the shape that caused ALM-9523; now
    // both directions are the same single derivation from the same rows, so
    // neither can be wider than the other.
    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("escalates over an unrelated prior reason when the streak holds", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "FailedForOtherReasons", {
      status: "error",
      errorReason: "Process exited with code 137",
    });
    // A full zero-usage streak behind a reason the detector did not write. The
    // prior reason is not consulted, so this agent is tripped like any other:
    // reading the agent row to decide is what ALM-9552 removed, and an agent
    // that happened to be carrying someone else's reason used to escape the
    // detector entirely until a succeeded run finalized alone.
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("holds the fault across a failed finalization", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFailedLoudly", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
      exitCode: 1,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // Hop 1 of the ALM-9534 release, and the assertion that had to invert. At
    // `8aa82b276` this pinned `{error, "Process exited with code 1"}` — the
    // failing run's own message winning, on the argument that the agent stays
    // unavailable either way. It does stay unavailable HERE. But this branch
    // is also the only writer of the column the hold keys on, so the run's
    // message evicted the marker and the NEXT finalization found nothing to
    // hold. The sequence fixtures below are that next finalization.
    //
    // `timed_out` reaches the identical cell — it is the other outcome that
    // resolves to a base status of `error` with a `failureReason` in hand.
    expect(await runOnceAndReadAgent(agentId, "failed")).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("keeps a failed run's own reason on an agent the detector never tripped", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "FailedButNeverTripped", {
      status: "error",
      errorReason: "Process exited with code 137",
      exitCode: 1,
    });
    // One healthy run at the head, so the detector has no finding and the
    // failing run keeps its own message. This is the bound on the ALM-9534
    // fix: without it, "a tripped agent's fault survives a failed
    // finalization" is indistinguishable from "a failing run never writes its
    // own message again," which would strand every ordinary adapter failure
    // behind the detector's reason.
    //
    // The seed changed at ALM-9552 and the title is why. It read
    // `dead(FALSE_LIVENESS_STREAK_THRESHOLD)` — a FULL streak, on a fixture
    // whose name says the detector never tripped — and passed only because the
    // escalation was gated on the finalizing run's outcome, so a tripped agent
    // slipped through. Once the streak alone decides, the old seed asserted
    // that a tripped agent keeps an unrelated reason, which is the opposite of
    // what this fixture is for. The separator is now the streak, so the streak
    // is what this varies.
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await runOnceAndReadAgent(agentId, "failed")).toEqual({
      status: "error",
      errorReason: "Process exited with code 1",
    });
  });

  // The `failed` + `keepIdleOnFailure` arm stays uncovered: no fixture reaches
  // a failed run that resolves to a base status of `idle`. It is structurally
  // inside the hold — the condition no longer reads `baseStatus` at all — but
  // that is an argument, not an example (AdversarialEng ADV-2, ALM-9534).

  // And this last group runs TWO finalizations against one agent (ALM-9534).
  // Every fixture above observes a single write, and the release they missed is
  // invisible to all of them because it composes two individually-correct
  // writes: at `8aa82b276` the output state of `keeps a failed run's own reason
  // on a tripped agent` — the fixture now named `holds the fault across a
  // failed finalization`, back when it asserted the opposite — WAS the input
  // state of `leaves an ordinary failure reason to the ordinary path`, and both
  // were green. No single-point mutant can see that either, since each half is
  // correct on its own, which is why these are sequences rather than probes.

  it("holds the fault across a failed finalization and the interrupt that follows", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFailedThenDrained", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
      exitCode: 1,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // Hop 1 is a failed run; hop 2 is the deploy that follows. Both are
    // collected BEFORE either is asserted, on purpose: asserting hop 1 first
    // aborts the example there, and then this fixture reds for the same reason
    // the single-write one above does and never exercises the sequence at all.
    // Asserted together, one failure shows the whole trajectory — which at
    // `8aa82b276` is `{error, FALSE_LIVENESS}` -> `{error, "Process exited with
    // code 1"}` -> `{idle, null}`: the agent advertised as healthy with its
    // zero-usage streak untouched and its adapter still broken. Strictly worse
    // than the `error` it came from. Neither hop is exotic — an agent that
    // trips this detector fails constantly, and a graceful shutdown interrupts
    // every in-flight run.
    const afterFailure = await runOnceAndReadAgent(agentId, "failed");
    const afterInterrupt = await interruptOnceAndReadAgent(companyId, agentId);

    expect({ afterFailure, afterInterrupt }).toEqual({
      afterFailure: {
        status: "error",
        errorReason: FALSE_LIVENESS_ERROR_REASON,
      },
      afterInterrupt: {
        status: "error",
        errorReason: FALSE_LIVENESS_ERROR_REASON,
      },
    });
  });

  it("holds the fault across a failed finalization and the cancel that follows", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFailedThenCancelled", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
      exitCode: 1,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // One variable apart from the sequence above: hop 2 is a cancel. That is
    // the second outcome reaching the same `idle` disjunct, and it arrives from
    // ordinary scheduling — the workspace-busy deferral — rather than once per
    // deploy, so it is the likelier of the two to fire and the one an
    // outcome-by-outcome fix would leave open.
    const afterFailure = await runOnceAndReadAgent(agentId, "failed");
    const afterCancel = await cancelOnceAndReadAgent(companyId, agentId);

    expect({ afterFailure, afterCancel }).toEqual({
      afterFailure: {
        status: "error",
        errorReason: FALSE_LIVENESS_ERROR_REASON,
      },
      afterCancel: {
        status: "error",
        errorReason: FALSE_LIVENESS_ERROR_REASON,
      },
    });
  });
});
