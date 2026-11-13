import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, automaticRunBrakes, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  AUTOMATIC_RUN_BRAKE, automaticRunOutcomeRules, automaticWorkStatusText, classifyAutomaticRunOutcome, createAutomaticRunBrake,
  isAutomaticRun,
} from "../services/recovery/automatic-run-brake.js";
import { taskAutomaticAttempts } from "../services/recovery/task-automatic-attempts.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;

type Run = typeof heartbeatRuns.$inferSelect;

suite("automatic-run brake", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-automatic-run-brake-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`truncate table automatic_run_brakes, agent_wakeup_requests, heartbeat_runs, agents, companies cascade`);
  }, 120_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); }, 120_000);

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Brake", issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const agentIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: `Worker ${index}`, role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
      agentIds.push(agentId);
    }
    return { companyId, agentIds };
  }

  async function insertRuns(companyId: string, agentId: string, count: number, values: (index: number) => Partial<typeof heartbeatRuns.$inferInsert>) {
    if (count === 0) return [] as Run[];
    return db.insert(heartbeatRuns).values(Array.from({ length: count }, (_, index) => ({ companyId, agentId,
      invocationSource: "automation", triggerDetail: "system", runtimeMode: "legacy",
      contextSnapshot: { wakeReason: "transient_failure_retry", issueId: randomUUID() }, ...values(index) }))).returning();
  }

  const ago = (ms: number) => new Date(Date.now() - ms);

  function failedBeforeStarting(companyId: string, agentId: string, count: number, errorCode = "environment_provider_unavailable") {
    return insertRuns(companyId, agentId, count, index => ({ status: "failed", errorCode, executionStage: "preparing",
      createdAt: ago(4 * MINUTE + index), startedAt: ago(3 * MINUTE + index), finishedAt: ago(MINUTE - index * 100),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }));
  }

  function interruptedWhileWorking(companyId: string, agentId: string, count: number) {
    const codes = ["controller_lease_lost", "server_shutdown_interrupted", "process_lost", "native_session_interrupted"];
    return insertRuns(companyId, agentId, count, index => ({ status: index % 2 ? "failed" : "interrupted", errorCode: codes[index % codes.length],
      executionStage: "dispatching", lastOutputAt: ago(40_000), createdAt: ago(20 * MINUTE), startedAt: ago(19 * MINUTE),
      finishedAt: ago(30_000 - index * 500), contextSnapshot: { wakeReason: "issue_assigned", issueId: randomUUID() } }));
  }

  function healthy(companyId: string, agentId: string, count: number, status: "succeeded" | "failed" = "succeeded") {
    return insertRuns(companyId, agentId, count, index => ({ status, errorCode: status === "failed" ? "adapter_failed" : null,
      executionStage: "dispatching", lastOutputAt: ago(10_000), createdAt: ago(5 * MINUTE), startedAt: ago(4 * MINUTE),
      finishedAt: ago(5_000 - index * 10) }));
  }

  function queuedAutomatic(companyId: string, agentId: string, count: number) {
    return insertRuns(companyId, agentId, count, index => ({ status: "queued", createdAt: ago(30_000 - index),
      contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: randomUUID(), issueId: randomUUID() } }));
  }

  async function forgetRuns(ids: string[]) {
    await db.update(heartbeatRuns).set({ createdAt: sql`created_at - interval '1 hour'`, startedAt: sql`started_at - interval '1 hour'`,
      finishedAt: sql`finished_at - interval '1 hour'` }).where(inArray(heartbeatRuns.id, ids));
  }

  async function ageBrake(companyId: string, ms: number) {
    const shift = `${ms} milliseconds`;
    await db.update(automaticRunBrakes).set({
      stateChangedAt: sql`state_changed_at - ${shift}::interval`, openedAt: sql`opened_at - ${shift}::interval`,
      nextProbeAt: sql`next_probe_at - ${shift}::interval`, nextCreationAt: sql`next_creation_at - ${shift}::interval`,
      releaseWindowStartedAt: sql`release_window_started_at - ${shift}::interval`,
    }).where(eq(automaticRunBrakes.companyId, companyId));
  }

  const brakeRow = async (companyId: string) => (await db.select().from(automaticRunBrakes).where(eq(automaticRunBrakes.companyId, companyId)))[0];

  async function openBrake(companyId: string, agentId: string, brake = createAutomaticRunBrake()) {
    const failures = await failedBeforeStarting(companyId, agentId, 20);
    expect((await brake.refresh(db, companyId)).state).toBe("open");
    return failures;
  }

  async function heldCount(brake: ReturnType<typeof createAutomaticRunBrake>, runs: Run[], options: { personOrigin?: boolean } = {}) {
    let started = 0;
    for (const run of runs) if (!await brake.holdAutomaticRunStart(db, run, options)) started += 1;
    return started;
  }

  function countingDb() {
    let queries = 0;
    const counted = new Set(["select", "insert", "update", "delete", "execute"]);
    const proxy = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return counted.has(String(property)) ? (...args: unknown[]) => { queries += 1; return value.apply(target, args); } : value.bind(target);
      },
    });
    return { db: proxy as typeof db, queries: () => queries };
  }

  it("classifies automatic runs and outcomes with the shared person and restart rules", async () => {
    const rules = await automaticRunOutcomeRules();
    expect(isAutomaticRun({ id: "a", companyId: "c", contextSnapshot: { wakeReason: "issue_continuation_needed" } })).toBe(true);
    expect(isAutomaticRun({ id: "a", companyId: "c", scheduledRetryReason: "transient_failure" })).toBe(true);
    expect(isAutomaticRun({ id: "a", companyId: "c", contextSnapshot: { wakeReason: "task_retry", previousRunId: "x" } })).toBe(false);
    expect(isAutomaticRun({ id: "a", companyId: "c", contextSnapshot: { wakeReason: "issue_assigned" } })).toBe(false);
    const base = { status: "failed", runtimeMode: "legacy", startedAt: new Date(), hasOutput: false, providerWorkStarted: null };
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "environment_provider_unavailable", executionStage: "preparing" }, rules)).toBe("failed_before_starting");
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "controller_lease_lost", executionStage: "dispatching" }, rules)).toBe("neutral");
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "process_lost", executionStage: "preparing" }, rules)).toBe("neutral");
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "budget_hard_stop", executionStage: "preparing" }, rules)).toBe("healthy");
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "adapter_failed", executionStage: "dispatching" }, rules)).toBe("healthy");
    expect(classifyAutomaticRunOutcome({ ...base, errorCode: "adapter_failed", executionStage: null, providerWorkStarted: "false" }, rules)).toBe("failed_before_starting");
    expect(classifyAutomaticRunOutcome({ ...base, status: "running", errorCode: null, executionStage: "preparing" }, rules)).toBe("neutral");
    expect(classifyAutomaticRunOutcome({ ...base, status: "cancelled", errorCode: "environment_provider_unavailable", executionStage: "preparing" }, rules)).toBe("neutral");
    const preDispatch = { version: 1, providerWorkStarted: false };
    for (const runtimeMode of ["legacy", "native"]) {
      const shape = { ...base, runtimeMode, executionStage: runtimeMode === "legacy" ? "preparing" : null,
        providerWorkStarted: runtimeMode === "legacy" ? "false" : null, nativePreDispatchFailure: runtimeMode === "native" ? preDispatch : undefined };
      for (const errorCode of ["environment_provider_unavailable", "setup_failed", "adapter_failed"]) {
        expect(classifyAutomaticRunOutcome({ ...shape, errorCode }, rules)).toBe("failed_before_starting");
      }
      for (const errorCode of ["controller_lease_lost", "process_lost", "native_session_interrupted", "server_shutdown_interrupted"]) {
        expect(classifyAutomaticRunOutcome({ ...shape, errorCode }, rules)).toBe("neutral");
      }
      const working = { ...base, runtimeMode, executionStage: runtimeMode === "legacy" ? "dispatching" : null, hasOutput: true };
      expect(classifyAutomaticRunOutcome({ ...working, errorCode: "adapter_failed" }, rules)).toBe("healthy");
      expect(classifyAutomaticRunOutcome({ ...working, errorCode: "environment_provider_unavailable" }, rules)).toBe("failed_before_starting");
    }
  });

  it("opens on native runs that failed before dispatch", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    await insertRuns(companyId, agentId!, 20, index => ({ runtimeMode: "native", status: "failed",
      errorCode: index % 2 ? "adapter_failed" : "setup_failed", createdAt: ago(4 * MINUTE), startedAt: ago(3 * MINUTE),
      finishedAt: ago(MINUTE - index * 100), nativePhase: "terminal_failure",
      resultJson: { nativePreDispatchFailure: { version: 1, providerWorkStarted: false }, failureCause: index % 2 ? "40P01" : "adapter_reported_error" } }));
    expect((await createAutomaticRunBrake().refresh(db, companyId))).toMatchObject({ state: "open",
      reason: { recentAutomaticRuns: 20, failedBeforeStarting: 20, trigger: "failed_before_starting" } });
  }, 60_000);

  it("sees failures that finished in the window behind more than 500 newer runs", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    const failures = await failedBeforeStarting(companyId, agentId!, 20, "setup_failed");
    await db.update(heartbeatRuns).set({ createdAt: sql`now() - interval '90 minutes'`, startedAt: sql`now() - interval '3 minutes'` })
      .where(inArray(heartbeatRuns.id, failures.map(run => run.id)));
    await queuedAutomatic(companyId, otherAgent!, 600);
    await insertRuns(companyId, otherAgent!, 50, () => ({ status: "succeeded", createdAt: ago(MINUTE), contextSnapshot: { wakeReason: "issue_assigned" } }));
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("open");
  }, 120_000);

  it("opens when automatic runs fail before starting, holds all but one probe, and never holds a person's work", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    const brake = createAutomaticRunBrake();
    await failedBeforeStarting(companyId, agentId!, 20);
    const snapshot = await brake.refresh(db, companyId);
    expect(snapshot).toMatchObject({ state: "open", reason: { recentAutomaticRuns: 20, failedBeforeStarting: 20 } });
    expect(automaticWorkStatusText(snapshot)).toMatch(/^Automatic work is paused for this company since .* because the last 5 automatic runs could not get a sandbox/);
    expect(automaticWorkStatusText(snapshot)).not.toMatch(/brake|probe|_/);

    const queued = [...await queuedAutomatic(companyId, agentId!, 25), ...await queuedAutomatic(companyId, otherAgent!, 25)];
    const attemptsBefore = await Promise.all(queued.map(run => taskAutomaticAttempts(db, companyId, String(run.contextSnapshot!.issueId), new Date())));
    expect(await heldCount(brake, queued, { personOrigin: false })).toBe(1);
    expect(await heldCount(createAutomaticRunBrake(), queued, { personOrigin: false })).toBe(0);
    const after = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, queued.map(run => run.id)));
    expect(after.every(run => run.status === "queued" && run.errorCode === null)).toBe(true);
    const attemptsAfter = await Promise.all(queued.map(run => taskAutomaticAttempts(db, companyId, String(run.contextSnapshot!.issueId), new Date())));
    expect(attemptsAfter.map(attempts => attempts.all.length)).toEqual(attemptsBefore.map(attempts => attempts.all.length));

    const [retry] = await insertRuns(companyId, agentId!, 1, () => ({ status: "queued", contextSnapshot: { wakeReason: "task_retry", previousRunId: queued[0]!.id } }));
    const [assignment] = await insertRuns(companyId, agentId!, 1, () => ({ status: "queued", contextSnapshot: { wakeReason: "issue_assigned" } }));
    const [joinedByPerson] = await insertRuns(companyId, agentId!, 1, () => ({ status: "queued",
      contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: randomUUID() } }));
    await db.insert(agentWakeupRequests).values({ companyId, agentId: agentId!, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: "board", runId: joinedByPerson!.id });
    const [continuationOfPersonRetry] = await insertRuns(companyId, agentId!, 1, () => ({ status: "queued",
      contextSnapshot: { wakeReason: "transient_failure_retry", previousRunId: retry!.id } }));
    for (const run of [retry!, assignment!, joinedByPerson!, continuationOfPersonRetry!]) {
      expect(await brake.holdAutomaticRunStart(db, run)).toBe(false);
    }
    expect(await brake.holdAutomaticRunStart(db, queued[3]!, { personOrigin: true })).toBe(false);
  }, 60_000);

  it("stays closed for mixed outcomes, person-owned failures and task failures after the agent started", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const brake = createAutomaticRunBrake();
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    expect(await brakeRow(companyId)).toBeUndefined();
    await failedBeforeStarting(companyId, agentId!, 8, "setup_failed");
    await healthy(companyId, agentId!, 4, "failed");
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    await insertRuns(companyId, agentId!, 30, index => ({ status: "failed", errorCode: index % 2 ? "budget_hard_stop" : "claude_auth_required",
      executionStage: "preparing", createdAt: ago(3 * MINUTE), startedAt: ago(2 * MINUTE), finishedAt: ago(MINUTE),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }));
    await healthy(companyId, agentId!, 30, "failed");
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    expect(await brakeRow(companyId)).toBeUndefined();
  }, 60_000);

  it("ignores failures older than the window", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const failures = await failedBeforeStarting(companyId, agentId!, 40);
    await db.update(heartbeatRuns).set({ finishedAt: sql`now() - interval '11 minutes'` }).where(inArray(heartbeatRuns.id, failures.map(run => run.id)));
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("closed");
  }, 60_000);

  it("stays closed through a release swap that interrupts working runs, and opens when their continuations cannot get a sandbox", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    const brake = createAutomaticRunBrake();
    await interruptedWhileWorking(companyId, agentId!, 40);
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    const continuations = [...await queuedAutomatic(companyId, agentId!, 20), ...await queuedAutomatic(companyId, otherAgent!, 20)];
    expect(await heldCount(createAutomaticRunBrake(), continuations)).toBe(40);
    expect((await brake.reserveCreation(db, companyId, { issueId: randomUUID(), sourceRunId: randomUUID() })).heldUntil).toBeNull();

    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "environment_provider_unavailable", executionStage: "preparing",
      startedAt: sql`now() - interval '20 seconds'`, finishedAt: sql`now() - interval '5 seconds'`,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(inArray(heartbeatRuns.id, continuations.map(run => run.id)));
    expect((await brake.refresh(db, companyId)).state).toBe("open");
  }, 60_000);

  it("opens on five sandbox refusals in a row, below the run count", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const brake = createAutomaticRunBrake();
    await failedBeforeStarting(companyId, agentId!, 4);
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    await failedBeforeStarting(companyId, agentId!, 1);
    expect((await brake.refresh(db, companyId)).state).toBe("open");
  }, 60_000);

  it("waits out a failed probe, then releases at a doubling rate after two probes reach the agent, and closes", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    const failures = await openBrake(companyId, agentId!);
    await forgetRuns(failures.map(run => run.id));
    const queued = [...await queuedAutomatic(companyId, agentId!, 30), ...await queuedAutomatic(companyId, otherAgent!, 30)];
    const probe = async () => {
      const brake = createAutomaticRunBrake();
      for (const run of queued) if (!await brake.holdAutomaticRunStart(db, run, { personOrigin: false })) return run;
      return null;
    };
    const first = await probe();
    expect(first).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "environment_provider_unavailable", executionStage: "preparing",
      startedAt: sql`now()`, finishedAt: sql`now()`, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, first!.id));
    queued.splice(queued.indexOf(first!), 1);
    expect(await probe()).toBeNull();
    expect((await brakeRow(companyId))).toMatchObject({ state: "open", probeSuccesses: 0, probeRunId: null });
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.probeIntervalMs);

    for (let success = 0; success < AUTOMATIC_RUN_BRAKE.probeSuccessesToRelease; success += 1) {
      const run = await probe();
      expect(run).not.toBeNull();
      await db.update(heartbeatRuns).set({ status: "running", startedAt: sql`now()`, executionStage: "dispatching" })
        .where(eq(heartbeatRuns.id, run!.id));
      queued.splice(queued.indexOf(run!), 1);
      await createAutomaticRunBrake().refresh(db, companyId);
    }
    expect(await brakeRow(companyId)).toMatchObject({ state: "open", probeSuccesses: 2 });
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.minOpenMs);
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("half_open");

    const startedPerWindow: number[] = [];
    for (let step = 0; step < AUTOMATIC_RUN_BRAKE.releaseSteps; step += 1) {
      const startedNow = await heldCount(createAutomaticRunBrake(), queued, { personOrigin: false })
        + await heldCount(createAutomaticRunBrake(), queued, { personOrigin: false });
      startedPerWindow.push(startedNow);
      await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.releaseIntervalMs);
    }
    expect(startedPerWindow).toEqual([2, 4, 8, 16, 32, 64]);
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("closed");
    expect(await heldCount(createAutomaticRunBrake(), queued, { personOrigin: false })).toBe(queued.length);
  }, 120_000);

  it("stays open when runs that started fine are followed by newer failures before starting", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const failures = await openBrake(companyId, agentId!);
    await forgetRuns(failures.map(run => run.id));
    await insertRuns(companyId, agentId!, 2, () => ({ status: "running", executionStage: "dispatching", lastOutputAt: ago(80_000),
      startedAt: ago(90_000), createdAt: ago(100_000) }));
    await failedBeforeStarting(companyId, agentId!, 10);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.minOpenMs);
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("open");
  }, 60_000);

  it("reopens from a gradual release when runs fail before starting again", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const failures = await openBrake(companyId, agentId!);
    await forgetRuns(failures.map(run => run.id));
    const recovered = await healthy(companyId, agentId!, 2);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.minOpenMs);
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("half_open");
    await forgetRuns(recovered.map(run => run.id));
    const again = await failedBeforeStarting(companyId, agentId!, 5);
    await db.update(heartbeatRuns).set({ finishedAt: sql`now()` }).where(inArray(heartbeatRuns.id, again.map(run => run.id)));
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("open");
  }, 60_000);

  it("frees the probe slot when the probe is cancelled, deleted or never starts", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    await openBrake(companyId, agentId!);
    const queued = [...await queuedAutomatic(companyId, agentId!, 3), ...await queuedAutomatic(companyId, otherAgent!, 3)];
    const brake = createAutomaticRunBrake();
    expect(await brake.holdAutomaticRunStart(db, queued[0]!, { personOrigin: false })).toBe(false);
    expect(await heldCount(createAutomaticRunBrake(), queued.slice(1), { personOrigin: false })).toBe(0);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.probeIntervalMs);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, queued[3]!, { personOrigin: false })).toBe(false);
    expect((await brakeRow(companyId))?.probeRunId).toBe(queued[3]!.id);

    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: sql`now()` }).where(eq(heartbeatRuns.id, queued[3]!.id));
    await createAutomaticRunBrake().refresh(db, companyId);
    expect((await brakeRow(companyId))?.probeRunId).toBeNull();
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.probeIntervalMs);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, queued[4]!, { personOrigin: false })).toBe(false);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, queued[4]!.id));
    await createAutomaticRunBrake().refresh(db, companyId);
    expect((await brakeRow(companyId))?.probeRunId).toBeNull();
  }, 60_000);

  it("lets another run take the probe when the reserved probe never starts within the claim bound", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    await openBrake(companyId, agentId!);
    const [first] = await queuedAutomatic(companyId, agentId!, 1);
    const [second] = await queuedAutomatic(companyId, otherAgent!, 1);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, first!, { personOrigin: false })).toBe(false);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, second!, { personOrigin: false })).toBe(true);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.probeClaimBoundMs + 1_000);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, second!, { personOrigin: false })).toBe(false);
    expect((await brakeRow(companyId))?.probeRunId).toBe(second!.id);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: sql`now()` }).where(eq(heartbeatRuns.id, second!.id));
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.probeClaimBoundMs + 1_000);
    expect(await createAutomaticRunBrake().holdAutomaticRunStart(db, first!, { personOrigin: false })).toBe(true);
  }, 60_000);

  it("closes by itself when no automatic run started or finished for the quiet bound, even with runs waiting", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    const failures = await openBrake(companyId, agentId!);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.quietCloseMs - MINUTE);
    expect((await createAutomaticRunBrake().refresh(db, companyId)).state).toBe("open");
    await forgetRuns(failures.map(run => run.id));
    await queuedAutomatic(companyId, agentId!, 5);
    await ageBrake(companyId, 2 * MINUTE);
    expect((await createAutomaticRunBrake().refresh(db, companyId))).toMatchObject({ state: "closed", reason: { trigger: "no_automatic_work" } });
  }, 60_000);

  it("lets two servers agree on the state and start one probe between them", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    await failedBeforeStarting(companyId, agentId!, 20);
    const [left, right] = [createAutomaticRunBrake(), createAutomaticRunBrake()];
    const [leftState, rightState] = await Promise.all([left.refresh(db, companyId), right.refresh(db, companyId)]);
    expect([leftState.state, rightState.state]).toEqual(["open", "open"]);
    expect(leftState.stateChangedAt?.getTime()).toBe(rightState.stateChangedAt?.getTime());
    const queued = [...await queuedAutomatic(companyId, agentId!, 25), ...await queuedAutomatic(companyId, otherAgent!, 25)];
    const results = await Promise.all(queued.map((run, index) => (index % 2 ? left : right).holdAutomaticRunStart(db, run, { personOrigin: false })));
    expect(results.filter(held => !held)).toHaveLength(1);
  }, 60_000);

  it("allows one new automatic run a minute while open and no automatic run is starting, across servers", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    await openBrake(companyId, agentId!);
    const work = { issueId: randomUUID(), sourceRunId: randomUUID() };
    const [left, right] = [createAutomaticRunBrake(), createAutomaticRunBrake()];
    const decisions = await Promise.all([left, right, left, right].map(async brake => (await brake.reserveCreation(db, companyId, work)).heldUntil));
    expect(decisions.filter(held => held === null)).toHaveLength(1);
    const later = decisions.find(Boolean)!;
    expect(later.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await queuedAutomatic(companyId, agentId!, 3);
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.creationIntervalMs);
    expect((await createAutomaticRunBrake().reserveCreation(db, companyId, work)).heldUntil).toBeNull();
    await insertRuns(companyId, agentId!, 1, () => ({ status: "running", executionStage: "preparing", startedAt: ago(20_000) }));
    await ageBrake(companyId, AUTOMATIC_RUN_BRAKE.creationIntervalMs);
    expect((await createAutomaticRunBrake().reserveCreation(db, companyId, work)).heldUntil).not.toBeNull();
  }, 60_000);

  it("keeps a pass over hundreds of held runs at a bounded number of queries", async () => {
    const { companyId, agentIds: [agentId, otherAgent] } = await seedCompany();
    await openBrake(companyId, agentId!);
    const queued = [...await queuedAutomatic(companyId, agentId!, 125), ...await queuedAutomatic(companyId, otherAgent!, 125)];
    const counting = countingDb();
    const brake = createAutomaticRunBrake();
    let started = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      for (const run of queued) {
        if (await brake.holdAutomaticRunStart(counting.db, run, { personOrigin: false })) continue;
        started += 1;
        await db.update(heartbeatRuns).set({ status: "running", startedAt: sql`now()` }).where(eq(heartbeatRuns.id, run.id));
      }
    }
    expect(started).toBe(1);
    expect(counting.queries()).toBeLessThanOrEqual(6);

    const fallback = countingDb();
    const second = createAutomaticRunBrake();
    for (let pass = 0; pass < 100; pass += 1) for (const run of queued) await second.holdAutomaticRunStart(fallback.db, run);
    expect(fallback.queries()).toBeLessThanOrEqual(queued.length + 5);
  }, 120_000);

  it("reads as closed and logs once when its run rules cannot load", async () => {
    const { companyId, agentIds: [agentId] } = await seedCompany();
    await failedBeforeStarting(companyId, agentId!, 20);
    const loadRules = vi.fn(async () => { throw new Error("module failed to load"); });
    const brake = createAutomaticRunBrake({ loadRules });
    const queued = await queuedAutomatic(companyId, agentId!, 3);
    expect((await brake.refresh(db, companyId)).state).toBe("closed");
    expect((await brake.reserveCreation(db, companyId, { issueId: randomUUID(), sourceRunId: randomUUID() })).heldUntil).toBeNull();
    expect(await heldCount(brake, queued)).toBe(3);
    expect(await brakeRow(companyId)).toBeUndefined();
  }, 60_000);

  it("keeps its in-process memory bounded across many companies and runs", async () => {
    const brake = createAutomaticRunBrake();
    const { companyId, agentIds: [agentId] } = await seedCompany();
    for (let index = 0; index < AUTOMATIC_RUN_BRAKE.maxCompanies + 100; index += 1) await brake.read(db, randomUUID());
    await openBrake(companyId, agentId!, brake);
    for (let index = 0; index < AUTOMATIC_RUN_BRAKE.maxRuns + 200; index += 1) {
      await brake.holdAutomaticRunStart(db, { id: randomUUID(), companyId, contextSnapshot: { wakeReason: "issue_continuation_needed" } });
    }
    expect(brake.cacheSizes()).toEqual({ companies: AUTOMATIC_RUN_BRAKE.maxCompanies, runs: AUTOMATIC_RUN_BRAKE.maxRuns });
  }, 180_000);
});
