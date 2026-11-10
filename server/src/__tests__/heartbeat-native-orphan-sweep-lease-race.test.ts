import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, closeLivenessDb, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  lockNativeExecutionLeaseForReacquire, nativeExecutionLeaseHeldCondition, renewNativeSessionExecutionLease,
} from "../services/native-runtime/native-execution-lease.js";
import { NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "../services/native-runtime/native-runner-ownership.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping orphan-sweep lease race tests: ${support.reason ?? "unsupported environment"}`);

/** The owning server: another process on the same database. */
const controller = { bootId: `boot-${randomUUID()}`, pid: 4243, processStartedAt: new Date("2026-11-10T05:15:54.000Z") };
const GENERATION = 1;

/**
 * Host sleep with two servers on one database (plan
 * doc/plans/2026-11-09-explicit-native-lease-claim-tokens.md, gap 2). The
 * owner's executor lease lapsed only because its host slept. Another server's
 * orphan sweep reads the lapsed lease; the owner wakes and takes the lease back
 * before the sweep writes. The sweep must not then mark the healthy run
 * ownership-unverified: that marker tells the board automatic recovery is
 * blocked, and it fences the owner out of its own lease after the next sleep,
 * so the turn is interrupted and the user must click Retry.
 */
describeEmbeddedPostgres("another server's orphan sweep racing the owner's lease take-back", () => {
  let db!: ReturnType<typeof createDb>;
  let owner!: ReturnType<typeof createDb>;
  let stopDatabase: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-orphan-sweep-lease-race-");
    stopDatabase = started.cleanup;
    db = createDb(started.connectionString);
    owner = createDb(started.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Sweep race", issuePrefix: "SWR",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {}, permissions: {} });
  }, 120_000);

  afterAll(async () => {
    if (owner) await closeLivenessDb(owner, 1).catch(() => undefined);
    await owner?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await stopDatabase?.();
  });

  async function seedSleptRun() {
    const issueId = randomUUID();
    const runId = randomUUID();
    const leaseOwner = `runner-slept:${randomUUID()}`;
    await db.insert(issues).values({ id: issueId, companyId, identifier: `SWR-${runId.slice(0, 8)}`,
      title: "slept", status: "in_progress", priority: "medium", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativePhase: "observed", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId }, startedAt: sql`clock_timestamp() - interval '41 minutes'` as unknown as Date });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner, leaseExpiresAt: sql`clock_timestamp() - interval '40 minutes'`,
      controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt, controllerHostHash: "host-a",
      controllerGeneration: GENERATION });
    return { runId, companyId, issueId, leaseOwner };
  }

  async function waitForLockWaiter() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await owner.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`);
      if (Number((rows as unknown as Array<{ waiting: number }>)[0]?.waiting ?? 0) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  it("leaves the run unmarked when the owner takes its lapsed lease back first", async () => {
    const run = await seedSleptRun();
    const sweep = heartbeatService(db);
    let sweepDone: Promise<unknown> | undefined;
    // The owner's take-back, held open: coordinator lock, then the run (shared).
    await owner.transaction(async tx => {
      const live = await lockNativeExecutionLeaseForReacquire(tx, run);
      expect(live).toBe(false);
      // The sweep reads the lapsed lease now and blocks at its write.
      sweepDone = sweep.reapOrphanedRuns();
      expect(await waitForLockWaiter()).toBe(true);
      const renewed = await tx.update(nativeRunFinalizations)
        .set({ leaseExpiresAt: sql`clock_timestamp() + interval '20 minutes'`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(nativeRunFinalizations.runId, run.runId), eq(nativeRunFinalizations.leaseOwner, run.leaseOwner),
          eq(nativeRunFinalizations.attempt, 1), eq(nativeRunFinalizations.controllerBootId, controller.bootId),
          eq(nativeRunFinalizations.controllerPid, controller.pid),
          eq(nativeRunFinalizations.controllerProcessStartedAt, controller.processStartedAt),
          nativeExecutionLeaseHeldCondition({ remote: false, controllerGeneration: GENERATION })))
        .returning({ runId: nativeRunFinalizations.runId });
      expect(renewed).toHaveLength(1);
    });
    await sweepDone;

    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.runId));
    expect(saved).toMatchObject({ status: "running", errorCode: null, error: null });
    const warnings = await db.select({ message: heartbeatRunEvents.message }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, run.runId), eq(heartbeatRunEvents.level, "warn")));
    expect(warnings).toEqual([]);

    // The host sleeps again before the turn ends: the owner must still take its own lease back.
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() - interval '40 minutes'` })
      .where(eq(nativeRunFinalizations.runId, run.runId));
    await expect(renewNativeSessionExecutionLease({ db: owner, ...run, attempt: 1, controller,
      reacquire: { controllerGeneration: GENERATION } })).resolves.toBeUndefined();
  });

  it("still marks a lapsed run whose owner never came back", async () => {
    const run = await seedSleptRun();
    await heartbeatService(db).reapOrphanedRuns();
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.runId));
    expect(saved).toMatchObject({ status: "running", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE });
    // ... and the late owner stays fenced out.
    await expect(renewNativeSessionExecutionLease({ db: owner, ...run, attempt: 1, controller,
      reacquire: { controllerGeneration: GENERATION } })).rejects.toThrow("native_session_lease_lost");
  });
});
