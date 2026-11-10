import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, closeLivenessDb, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import {
  lockNativeExecutionLeaseForReacquire, nativeExecutionLeaseHeldCondition, renewNativeSessionExecutionLease,
  startNativeSessionExecutionLeaseRenewal,
} from "./native-execution-lease.js";
import { OPERATOR_ATTESTED_CONTROLLER_HOST } from "./native-controller-host-recovery.js";
import { NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "./native-runner-ownership.js";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping native lease re-acquire tests: ${support.reason ?? "unsupported environment"}`);

const controller = { bootId: `boot-${randomUUID()}`, pid: 4242, processStartedAt: new Date("2026-11-10T05:15:54.000Z") };
const GENERATION = 1;

/**
 * Host sleep (restart-chaos TM2): the owner process is frozen while the wall
 * clock and database clock move on, so its stored lease lapsed although nobody
 * else took it. Each seeded run's lease lapsed 40 minutes ago, untouched.
 */
describeEmbeddedPostgres("native execution lease taken back after a host sleep", () => {
  let db!: ReturnType<typeof createDb>;
  let owner!: ReturnType<typeof createDb>;
  let stopDatabase: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-native-lease-reacquire-");
    stopDatabase = started.cleanup;
    db = createDb(started.connectionString);
    owner = createDb(started.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease", issuePrefix: "LRA",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {}, permissions: {} });
  }, 120_000);

  afterEach(() => vi.useRealTimers());

  afterAll(async () => {
    if (owner) await closeLivenessDb(owner, 1).catch(() => undefined);
    await owner?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await stopDatabase?.();
  });

  async function seedSleptRun(label: string) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const leaseOwner = `runner-${label}:${randomUUID()}`;
    await db.insert(issues).values({ id: issueId, companyId, identifier: `LRA-${runId.slice(0, 8)}`,
      title: label, status: "in_progress", priority: "medium", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner, leaseExpiresAt: sql`clock_timestamp() - interval '40 minutes'`,
      controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt, controllerHostHash: "host-a",
      controllerGeneration: GENERATION });
    const binding = { runId, companyId, issueId };
    const renewal = { db: owner, ...binding, leaseOwner, attempt: 1, controller,
      reacquire: { controllerGeneration: GENERATION } };
    return { ...binding, leaseOwner, renewal };
  }
  type SleptRun = Awaited<ReturnType<typeof seedSleptRun>>;

  async function row(runId: string) {
    const [saved] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    return saved!;
  }

  it("lets the same owner take back a lease that lapsed untouched", async () => {
    const run = await seedSleptRun("untouched");
    await expect(renewNativeSessionExecutionLease(run.renewal)).resolves.toBeUndefined();
    const saved = await row(run.runId);
    expect(saved.leaseOwner).toBe(run.leaseOwner);
    expect(saved.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it("renews from the shared timer after the sleep instead of interrupting the turn", async () => {
    const run = await seedSleptRun("timer");
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const onLost = vi.fn(async () => undefined);
    const { reacquire: _reacquire, ...input } = run.renewal;
    const guard = startNativeSessionExecutionLeaseRenewal({ ...input, remote: false,
      controllerGeneration: GENERATION, onLost });
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(async () => expect((await row(run.runId)).leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now()));
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      await guard.stop();
    }
  });

  it("handles rows saved by the previous release: same shape, and never another boot's lease", async () => {
    // Rows saved before the host hash existed carry null there; the rule adds no column.
    const legacyRow = await seedSleptRun("legacy-row");
    await db.update(nativeRunFinalizations).set({ controllerHostHash: null })
      .where(eq(nativeRunFinalizations.runId, legacyRow.runId));
    await expect(renewNativeSessionExecutionLease(legacyRow.renewal)).resolves.toBeUndefined();
    // A deploy that lands mid-run: the lapsed lease belongs to the previous
    // server's boot, so the new process can never take it back as its own.
    const previousServer = await seedSleptRun("previous-boot");
    await expect(renewNativeSessionExecutionLease({ ...previousServer.renewal,
      controller: { ...controller, bootId: `boot-${randomUUID()}`, pid: controller.pid + 1 } }))
      .rejects.toThrow("native_session_lease_lost");
    expect((await row(previousServer.runId)).leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("still refuses a lapsed lease without the claimed generation, or on a remote target", async () => {
    const run = await seedSleptRun("no-generation");
    const { reacquire: _reacquire, ...legacy } = run.renewal;
    await expect(renewNativeSessionExecutionLease(legacy)).rejects.toThrow("native_session_lease_lost");
    await expect(renewNativeSessionExecutionLease({ ...legacy, reacquire: { controllerGeneration: GENERATION + 1 } }))
      .rejects.toThrow("native_session_lease_lost");
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const onLost = vi.fn(async () => undefined);
    const guard = startNativeSessionExecutionLeaseRenewal({ ...legacy, remote: true,
      controllerGeneration: GENERATION, onLost });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalled());
    await expect(guard.stop()).rejects.toThrow("native_session_lease_lost");
    expect((await row(run.runId)).leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  // Each actor that may act on a lapsed executor lease records that first. The
  // late owner must stay fenced out and must not undo the record.
  const claimants: Array<[string, (run: SleptRun) => Promise<unknown>]> = [
    ["restart recovery holds the run for evidence", run => db.update(nativeRunFinalizations)
      .set({ recoveryState: "awaiting_evidence" }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["a recovery request was recorded", run => db.update(nativeRunFinalizations)
      .set({ recoveryRequestId: randomUUID() }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["the finalizer claimed the row", run => db.update(nativeRunFinalizations)
      .set({ leaseOwner: `native-finalizer:${randomUUID()}`, leaseExpiresAt: sql`clock_timestamp() + interval '5 minutes'` })
      .where(eq(nativeRunFinalizations.runId, run.runId))],
    ["cleanup claimed the row", run => db.update(nativeRunFinalizations)
      .set({ leaseOwner: `native-cleanup:${randomUUID()}` }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["a restarted controller took over", run => db.update(nativeRunFinalizations)
      .set({ controllerBootId: `boot-${randomUUID()}`, controllerGeneration: GENERATION + 1 })
      .where(eq(nativeRunFinalizations.runId, run.runId))],
    ["the same controller's generation moved on", run => db.update(nativeRunFinalizations)
      .set({ controllerGeneration: GENERATION + 1 }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["a new provider attempt was claimed", run => db.update(nativeRunFinalizations)
      .set({ attempt: 2 }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["failure settlement recorded a retry", run => db.update(nativeRunFinalizations)
      .set({ phase: "retryable_failure", failureCode: "native_session_lease_lost", nextAttemptAt: new Date() })
      .where(eq(nativeRunFinalizations.runId, run.runId))],
    ["a retry is scheduled", run => db.update(nativeRunFinalizations)
      .set({ nextAttemptAt: new Date() }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["the run was already failed", run => db.update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.runId))],
    ["the run was cancelled", run => db.update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.runId))],
    ["the board confirmed the controller stopped", run => db.update(nativeRunFinalizations)
      .set({ controllerHostHash: OPERATOR_ATTESTED_CONTROLLER_HOST }).where(eq(nativeRunFinalizations.runId, run.runId))],
    ["another server's orphan sweep marked ownership unverified", run => db.update(heartbeatRuns)
      .set({ errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE, error: "unverified" })
      .where(eq(heartbeatRuns.id, run.runId))],
    ["startup cleanup was promoted", run => db.update(heartbeatRuns)
      .set({ resultJson: { nativeStartupCleanup: { state: "pending" } } }).where(eq(heartbeatRuns.id, run.runId))],
  ];

  it.each(claimants)("fences the late owner out when %s first", async (_name, claim) => {
    const run = await seedSleptRun("claimed");
    await claim(run);
    const before = await row(run.runId);
    await expect(renewNativeSessionExecutionLease(run.renewal)).rejects.toThrow("native_session_lease_lost");
    expect(await row(run.runId)).toEqual(before);
  });

  /** The executor's release and failure settlement use the same lock and held condition. */
  async function releaseAsOwner(run: SleptRun) {
    return owner.transaction(async tx => {
      await lockNativeExecutionLeaseForReacquire(tx, run);
      return tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(and(eq(nativeRunFinalizations.runId, run.runId), eq(nativeRunFinalizations.leaseOwner, run.leaseOwner),
          eq(nativeRunFinalizations.attempt, 1), eq(nativeRunFinalizations.controllerBootId, controller.bootId),
          nativeExecutionLeaseHeldCondition({ remote: false, controllerGeneration: GENERATION, relinquishAccepted: true })))
        .returning({ runId: nativeRunFinalizations.runId });
    });
  }

  it("releases its own lapsed lease after the result was accepted, but never renews it", async () => {
    const accepted = await seedSleptRun("accepted");
    // Only the coordinator's accepted-result shape matters here; skip the
    // completion-contract foreign keys rather than seed a whole contract.
    const [result] = await db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      return tx.insert(nativeRunResults).values({ companyId, issueId: accepted.issueId, runId: accepted.runId,
        completionContractId: randomUUID(), serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {},
        canonicalSha256: "a".repeat(64) }).returning({ id: nativeRunResults.id });
    });
    await db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing", resultId: result!.id })
      .where(eq(nativeRunFinalizations.runId, accepted.runId));
    // Workspace finalization may act on a lapsed post-result lease, so it is never renewed ...
    await expect(renewNativeSessionExecutionLease(accepted.renewal)).rejects.toThrow("native_session_lease_lost");
    // ... only relinquished, which grants nothing.
    expect(await releaseAsOwner(accepted)).toHaveLength(1);
    expect((await row(accepted.runId)).leaseOwner).toBeNull();
  });

  it("does not release a lapsed lease over a recorded recovery claim", async () => {
    const claimed = await seedSleptRun("release-claimed");
    await db.update(nativeRunFinalizations).set({ recoveryState: "awaiting_runner_reattach" })
      .where(eq(nativeRunFinalizations.runId, claimed.runId));
    expect(await releaseAsOwner(claimed)).toHaveLength(0);
    const saved = await row(claimed.runId);
    expect(saved.recoveryState).toBe("awaiting_runner_reattach");
    expect(saved.leaseOwner).toBe(claimed.leaseOwner);
  });

  /** A claimant that acts on expiry: lock the coordinator, re-check expiry, record the claim, in one transaction. */
  async function claimIfLapsed(runId: string, holdMs: number) {
    return db.transaction(async tx => {
      const [locked] = await tx.select({ expired: sql<boolean>`${nativeRunFinalizations.leaseExpiresAt} <= clock_timestamp()` })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).for("update");
      if (holdMs) await tx.execute(sql`select pg_sleep(${holdMs / 1000})`);
      if (!locked?.expired) return false;
      await tx.update(nativeRunFinalizations).set({ recoveryState: "awaiting_evidence" })
        .where(eq(nativeRunFinalizations.runId, runId));
      return true;
    });
  }

  /** A run writer that does not take the coordinator lock. */
  async function failRun(runId: string, holdMs: number) {
    return db.transaction(async tx => {
      const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)).for("update");
      await tx.execute(sql`select pg_sleep(${holdMs / 1000})`);
      if (run?.status !== "running") return false;
      await tx.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      return true;
    });
  }

  const renewed = (run: SleptRun) => renewNativeSessionExecutionLease(run.renewal)
    .then(() => true, (error: Error) => { expect(error.message).toBe("native_session_lease_lost"); return false; });

  it.each([
    ["the claimant locks first", 0, 80, false],
    ["the owner locks first", 80, 0, true],
  ])("lets exactly one side win a race on the coordinator (%s)", async (_name, claimDelayMs, ownerDelayMs, ownerWins) => {
    const run = await seedSleptRun("race");
    const [claimed, ownerWon] = await Promise.all([
      new Promise(resolve => setTimeout(resolve, claimDelayMs)).then(() => claimIfLapsed(run.runId, 300)),
      new Promise(resolve => setTimeout(resolve, ownerDelayMs)).then(() => renewed(run)),
    ]);
    expect(ownerWon).toBe(ownerWins);
    expect(claimed).toBe(!ownerWins);
    const saved = await row(run.runId);
    expect(saved.recoveryState).toBe(ownerWins ? null : "awaiting_evidence");
    expect(saved.leaseExpiresAt!.getTime() > Date.now()).toBe(ownerWins);
  });

  it("waits for an in-flight run status write instead of reading past it", async () => {
    const run = await seedSleptRun("status-race");
    const [failed, ownerWon] = await Promise.all([
      failRun(run.runId, 400),
      new Promise(resolve => setTimeout(resolve, 100)).then(() => renewed(run)),
    ]);
    expect(failed).toBe(true);
    expect(ownerWon).toBe(false);
    expect((await row(run.runId)).leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("has exactly one winner across simultaneous starts", async () => {
    for (let index = 0; index < 8; index++) {
      const run = await seedSleptRun(`burst-${index}`);
      const [claimed, ownerWon] = await Promise.all([claimIfLapsed(run.runId, 0), renewed(run)]);
      expect(Number(claimed) + Number(ownerWon)).toBe(1);
      const saved = await row(run.runId);
      expect(saved.recoveryState === null).toBe(ownerWon);
    }
  });
});
