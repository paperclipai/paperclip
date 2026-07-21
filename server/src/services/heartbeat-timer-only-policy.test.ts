/**
 * Timer-only agent isolation — real server-path invariant tests (FALA-880).
 *
 * These exercise the ACTUAL control-plane transitions against an embedded
 * Postgres (not a re-implemented gate simulation): the authoritative
 * queued→running claim (`claimQueuedRun`), scheduled-retry promotion
 * (`promoteDueScheduledRetries`), the resume driver (`resumeQueuedRuns`), and
 * the enqueue gate (`wakeup`).
 *
 * Invariant proven: while `runtimeConfig.heartbeat.timerOnly = true`, no
 * non-timer run — a queued assignment, a directly-inserted automation run, a
 * run queued before the policy flip, or a due scheduled retry — ever reaches
 * `running`. non-timer=0, overlap=0. A timer run is still allowed, and a
 * positive control confirms the SAME non-timer run claims to `running` when the
 * policy is off (so it is the timer-only gate, not some other gate, doing the
 * blocking).
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { agentService } from "./agents.js";
import { heartbeatService, parseHeartbeatPolicyForTest } from "./heartbeat.js";

// Fast, pure derivation checks — cheap and still useful, but they are NOT the
// invariant proof (the integration tests below are).
describe("parseHeartbeatPolicyForTest — timerOnly derivation", () => {
  it("defaults to timerOnly=false when not set", () => {
    const policy = parseHeartbeatPolicyForTest({ heartbeat: { enabled: true } });
    expect(policy.timerOnly).toBe(false);
    expect(policy.wakeOnDemand).toBe(true);
  });

  it("sets timerOnly=true and forces wakeOnDemand=false, overriding explicit wakeOnDemand", () => {
    const policy = parseHeartbeatPolicyForTest({
      heartbeat: { enabled: true, timerOnly: true, wakeOnDemand: true },
    });
    expect(policy.timerOnly).toBe(true);
    expect(policy.wakeOnDemand).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer-only isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("timer-only isolation — real control-plane paths", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-only-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Valid, invokable org: active company + active manager + engineer child.
  async function seedAgent(timerOnly: boolean) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer-only Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Manager",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Timer-only Agent",
        role: "engineer",
        reportsTo: managerId,
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 60, timerOnly, maxConcurrentRuns: 5 },
        },
        permissions: {},
      },
    ]);

    return { companyId, agentId };
  }

  async function insertQueuedRun(
    companyId: string,
    agentId: string,
    invocationSource: "timer" | "assignment" | "automation" | "on_demand",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource,
      status: "queued",
      // Pre-resolved so an ALLOWED run can dispatch without company-default
      // responsible-user setup; the timer-only gate runs before this is read.
      responsibleUserId: "test-responsible-user",
    });
    return runId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
  }

  it("claim: fail-closes a queued assignment run (non-timer) with timer_only_policy", async () => {
    const { companyId, agentId } = await seedAgent(true);
    const runId = await insertQueuedRun(companyId, agentId, "assignment");

    const heartbeat = heartbeatService(db);
    const claimed = await heartbeat.claimQueuedRun(await loadRun(runId));

    expect(claimed).toBeNull();
    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "timer_only_policy",
    });
  });

  it("claim: fail-closes a directly-inserted automation run (non-timer)", async () => {
    const { companyId, agentId } = await seedAgent(true);
    const runId = await insertQueuedRun(companyId, agentId, "automation");

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.claimQueuedRun(await loadRun(runId))).toBeNull();
    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "timer_only_policy",
    });
  });

  it("claim: fail-closes a non-timer run queued BEFORE the policy flip (transition race)", async () => {
    const { companyId, agentId } = await seedAgent(false);
    // Enqueued while the agent was NOT timer-only.
    const runId = await insertQueuedRun(companyId, agentId, "assignment");

    // Policy flips to timer-only while the run sits in the queue.
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 60, timerOnly: true, maxConcurrentRuns: 5 },
        },
      })
      .where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.claimQueuedRun(await loadRun(runId))).toBeNull();
    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "timer_only_policy",
    });
  });

  it("claim: allows a timer run under timer-only", async () => {
    const { companyId, agentId } = await seedAgent(true);
    const runId = await insertQueuedRun(companyId, agentId, "timer");

    const heartbeat = heartbeatService(db);
    const claimed = await heartbeat.claimQueuedRun(await loadRun(runId));

    expect(claimed?.status).toBe("running");
    expect(await runStatus(runId)).toMatchObject({ status: "running" });
  });

  it("claim positive control: the SAME non-timer run claims to running when timer-only is off", async () => {
    const { companyId, agentId } = await seedAgent(false);
    const runId = await insertQueuedRun(companyId, agentId, "assignment");

    const heartbeat = heartbeatService(db);
    const claimed = await heartbeat.claimQueuedRun(await loadRun(runId));

    expect(claimed?.status).toBe("running");
  });

  it("promote: suppresses a due non-timer scheduled retry under timer-only", async () => {
    const { companyId, agentId } = await seedAgent(true);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "scheduled_retry",
      scheduledRetryAt: new Date("2026-06-04T00:00:00Z"),
      scheduledRetryReason: "transient_failure",
      scheduledRetryAttempt: 1,
    });

    const heartbeat = heartbeatService(db);
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date("2026-06-04T00:10:00Z"));

    expect(promoted).toEqual({ promoted: 0, runIds: [] });
    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "timer_only_policy",
    });
  });

  it("enqueue: blocks a non-timer wakeup under timer-only and creates no run", async () => {
    const { agentId } = await seedAgent(true);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "assignment_wake",
    });

    expect(run).toBeNull();
    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((r) => r.agentId === agentId).length);
    expect(runCount).toBe(0);
  });

  it("race: concurrent timerOnly-enable and claim serialize on the agent row (overlap=0 under interleaving)", async () => {
    const svc = agentService(db);
    const heartbeat = heartbeatService(db);
    const { companyId, agentId } = await seedAgent(false);

    const offConfig = { heartbeat: { enabled: true, intervalSec: 60, timerOnly: false, maxConcurrentRuns: 5 } };
    const onConfig = { heartbeat: { enabled: true, intervalSec: 60, timerOnly: true, maxConcurrentRuns: 5 } };

    // Repeat to exercise both interleavings (enable-wins-lock and claim-wins-lock).
    for (let i = 0; i < 30; i++) {
      await db.update(agents).set({ runtimeConfig: offConfig }).where(eq(agents.id, agentId));
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      const runId = await insertQueuedRun(companyId, agentId, "automation");

      // Fire both real writers concurrently. `svc.update` enables timerOnly and
      // `claimQueuedRun` flips the queued non-timer run to running; each takes the
      // SAME per-agent advisory lock before its decisive write (the enable guard
      // now lives INSIDE `agentService.update`, not a caller-supplied callback),
      // so they can never interleave.
      const [enableRes] = await Promise.allSettled([
        svc.update(agentId, { runtimeConfig: onConfig }),
        heartbeat.claimQueuedRun(await loadRun(runId)),
      ]);

      const running = await db
        .select({ id: heartbeatRuns.id, invocationSource: heartbeatRuns.invocationSource })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      const nonTimerRunning = running.filter((r) => r.invocationSource !== "timer");

      const agentRow = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]!);
      const policy = parseHeartbeatPolicyForTest(agentRow.runtimeConfig);

      // THE INVARIANT: timerOnly=true and a running non-timer run are mutually
      // exclusive — overlap=0 — for EVERY interleaving.
      expect(policy.timerOnly && nonTimerRunning.length > 0).toBe(false);

      if (policy.timerOnly) {
        // Enable won the lock; the claim then fail-closed the non-timer run.
        expect(nonTimerRunning).toHaveLength(0);
        expect(await runStatus(runId)).toMatchObject({
          status: "cancelled",
          errorCode: "timer_only_policy",
        });
      } else {
        // Claim won the lock; the enable was rejected by its guard, leaving the
        // policy off — so the running non-timer run is not a violation.
        expect(enableRes.status).toBe("rejected");
      }
    }
  });

  // Records a config revision whose snapshot has timerOnly=true, then leaves the
  // agent back at timerOnly=false. Returns the id of the timerOnly=true revision
  // — a valid rollback target that would re-enable the policy.
  async function recordTimerOnlyRevision(agentId: string): Promise<string> {
    const svc = agentService(db);
    const onConfig = { heartbeat: { enabled: true, intervalSec: 60, timerOnly: true, maxConcurrentRuns: 5 } };
    const offConfig = { heartbeat: { enabled: true, intervalSec: 60, timerOnly: false, maxConcurrentRuns: 5 } };
    const recordRevision = { source: "patch" as const };
    await svc.update(agentId, { runtimeConfig: onConfig }, { recordRevision });
    await svc.update(agentId, { runtimeConfig: offConfig }, { recordRevision });
    const revisions = await svc.listConfigRevisions(agentId);
    const timerOnlyRevision = revisions.find(
      (r) => parseHeartbeatPolicyForTest((r.afterConfig as { runtimeConfig?: unknown })?.runtimeConfig).timerOnly,
    );
    if (!timerOnlyRevision) throw new Error("expected a timerOnly=true revision to exist");
    return timerOnlyRevision.id;
  }

  async function insertRunningRun(
    companyId: string,
    agentId: string,
    invocationSource: "timer" | "assignment" | "automation" | "on_demand",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource,
      status: "running",
      responsibleUserId: "test-responsible-user",
      startedAt: new Date(),
    });
    return runId;
  }

  it("rollback: refuses to restore a timerOnly=true revision while a non-timer run is running (overlap=0)", async () => {
    const svc = agentService(db);
    const { companyId, agentId } = await seedAgent(false);
    const revisionId = await recordTimerOnlyRevision(agentId);

    // A non-timer run is already running when the rollback is attempted.
    await insertRunningRun(companyId, agentId, "assignment");

    // Restoring the timerOnly=true snapshot must go through the SAME advisory
    // lock + active-run guard as the PATCH/claim paths, so it is rejected.
    await expect(
      svc.rollbackConfigRevision(agentId, revisionId, { agentId: null, userId: null }),
    ).rejects.toMatchObject({ status: 409, details: { code: "timer_only_active_non_timer_run" } });

    // The policy stays off, so the running non-timer run is not a violation.
    const agentRow = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(parseHeartbeatPolicyForTest(agentRow.runtimeConfig).timerOnly).toBe(false);
  });

  it("race: concurrent config rollback and claim serialize (overlap=0 under interleaving)", async () => {
    const svc = agentService(db);
    const heartbeat = heartbeatService(db);
    const { companyId, agentId } = await seedAgent(false);
    const revisionId = await recordTimerOnlyRevision(agentId);
    const offConfig = { heartbeat: { enabled: true, intervalSec: 60, timerOnly: false, maxConcurrentRuns: 5 } };

    // Repeat to exercise both interleavings (rollback-wins-lock and claim-wins-lock).
    for (let i = 0; i < 30; i++) {
      await db.update(agents).set({ runtimeConfig: offConfig }).where(eq(agents.id, agentId));
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      const runId = await insertQueuedRun(companyId, agentId, "automation");

      // The rollback re-enables timerOnly and the claim flips the queued non-timer
      // run to running; both take the SAME per-agent advisory lock before writing.
      const [rollbackRes] = await Promise.allSettled([
        svc.rollbackConfigRevision(agentId, revisionId, { agentId: null, userId: null }),
        heartbeat.claimQueuedRun(await loadRun(runId)),
      ]);

      const running = await db
        .select({ id: heartbeatRuns.id, invocationSource: heartbeatRuns.invocationSource })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      const nonTimerRunning = running.filter((r) => r.invocationSource !== "timer");

      const agentRow = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]!);
      const policy = parseHeartbeatPolicyForTest(agentRow.runtimeConfig);

      // THE INVARIANT: timerOnly=true and a running non-timer run are mutually
      // exclusive — overlap=0 — for EVERY interleaving.
      expect(policy.timerOnly && nonTimerRunning.length > 0).toBe(false);

      if (policy.timerOnly) {
        // Rollback won the lock; the claim then fail-closed the non-timer run.
        expect(nonTimerRunning).toHaveLength(0);
        expect(await runStatus(runId)).toMatchObject({
          status: "cancelled",
          errorCode: "timer_only_policy",
        });
      } else {
        // Claim won the lock; the rollback was rejected by its guard, leaving the
        // policy off — so the running non-timer run is not a violation.
        expect(rollbackRes.status).toBe("rejected");
      }
    }
  });

  it("canary: a timer run and a non-timer run never overlap (non-timer=0, overlap=0)", async () => {
    const { companyId, agentId } = await seedAgent(true);
    const timerRun = await insertQueuedRun(companyId, agentId, "timer");
    const nonTimerRun = await insertQueuedRun(companyId, agentId, "automation");

    const heartbeat = heartbeatService(db);

    // The timer run is allowed to run…
    const timerClaimed = await heartbeat.claimQueuedRun(await loadRun(timerRun));
    expect(timerClaimed?.status).toBe("running");

    // …and while it is running, a non-timer run is fail-closed at claim.
    const nonTimerClaimed = await heartbeat.claimQueuedRun(await loadRun(nonTimerRun));
    expect(nonTimerClaimed).toBeNull();
    expect(await runStatus(nonTimerRun)).toMatchObject({
      status: "cancelled",
      errorCode: "timer_only_policy",
    });

    // Exactly one run is running, and it is the timer run: overlap=0, non-timer=0.
    const running = await db
      .select({ id: heartbeatRuns.id, invocationSource: heartbeatRuns.invocationSource })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ id: timerRun, invocationSource: "timer" });
  });
});
