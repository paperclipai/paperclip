import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  recoveryEngineerConfigs,
  recoveryEngineerIncidentSources,
  recoveryEngineerIncidents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { recoveryEngineerService } from "../services/recovery-engineer.js";

type RecoveryEngineerWakeup = Parameters<typeof recoveryEngineerService>[1]["enqueueWakeup"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery-engineer incident-dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Blocks the pool=1 real-dispatcher test's admitted run: the run is claimed
 * and bound (what the test asserts) but never executes an adapter until the
 * test releases it, so teardown never races an in-flight execution. */
const BLOCKED_POOL_ONE_ADAPTER = "pool_one_blocked_test";
const poolOneRunGate = Promise.withResolvers<void>();

describeEmbeddedPostgres("recovery-engineer incident dispatch", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-incident-dispatch-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: BLOCKED_POOL_ONE_ADAPTER,
      execute: async () => {
        await poolOneRunGate.promise;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          resultJson: { summary: "released by the pool one dispatch test" },
        };
      },
      testEnvironment: async () => ({
        adapterType: BLOCKED_POOL_ONE_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
  });

  afterAll(async () => {
    unregisterServerAdapter(BLOCKED_POOL_ONE_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const recoveryAgentId = randomUUID();
    const repairAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const incidentProjectId = randomUUID();
    const nativeRepairProjectId = randomUUID();
    const frameworkRepairProjectId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `ID${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Incident Dispatch Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "incident-dispatch-responsible-user",
    });
    await db.insert(agents).values([
      {
        id: recoveryAgentId,
        companyId,
        name: "Astra",
        role: "coordinator",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: repairAgentId,
        companyId,
        name: "Sol Repair",
        role: "implementer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Sol Review",
        role: "reviewer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Source Owner",
        role: "implementer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values([
      { id: incidentProjectId, companyId, name: "Recovery Incidents" },
      { id: nativeRepairProjectId, companyId, name: "Native Repairs" },
      { id: frameworkRepairProjectId, companyId, name: "Framework Repairs" },
    ]);
    await db.insert(recoveryEngineerConfigs).values({
      companyId,
      enabled: true,
      agentId: recoveryAgentId,
      repairAgentId,
      reviewerAgentId,
      projectId: incidentProjectId,
      repairProjectIds: {
        native: nativeRepairProjectId,
        framework: frameworkRepairProjectId,
      },
      maxAttempts: 1,
      sweepIntervalSec: 300,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original source task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return {
      companyId,
      prefix,
      recoveryAgentId,
      repairAgentId,
      reviewerAgentId,
      ownerAgentId,
      sourceIssueId,
    };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    errorCode?: string;
    error?: string;
    createdAt?: Date;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: input.status,
      nativeIssueId: input.issueId,
      contextSnapshot: input.contextSnapshot ?? { issueId: input.issueId, taskId: input.issueId },
      createdAt: input.createdAt,
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      finishedAt: ["failed", "succeeded", "cancelled"].includes(input.status)
        ? new Date("2026-09-09T10:01:00.000Z")
        : null,
      errorCode: input.errorCode,
      error: input.error,
      livenessState: null,
      lastUsefulActionAt: null,
    });
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, id))
      .then((rows) => rows[0]!);
  }

  /**
   * Mirrors the dispatcher contract of heartbeat.enqueueWakeup for the parts
   * the reconciliation depends on: a materialized enqueue persists the queued
   * wake row and its run and applies the pre-start binding hook inside its
   * "run-creation transaction" (before the run could be claimed), a
   * suppressed enqueue parks the intent on a bound scheduled-retry carrier
   * and returns no run, a refused enqueue that never reaches the request
   * table throws, and a heartbeat daily-cap refusal persists the skipped row
   * under the same idempotency key and returns no run. `holdDispatch` parks
   * the first admitted enqueue behind a resolver so a test can prove a second
   * dispatch pass stands down while the first is provably in flight.
   */
  function createWakeFake(input: { companyId: string }) {
    const state: {
      mode: "enqueue" | "parkCarrier" | "throw" | "dailyCap";
      holdDispatch: boolean;
    } = {
      mode: "enqueue",
      holdDispatch: false,
    };
    const dispatchStarted = Promise.withResolvers<void>();
    const holdDispatch = Promise.withResolvers<void>();
    let dispatchHeld = false;
    const calls: Array<{
      agentId: string;
      reason: string | null;
      idempotencyKey: string | null;
      issueId: string | null;
    }> = [];
    const enqueueWakeup: RecoveryEngineerWakeup = async (agentId, options) => {
      const issueId = typeof options.contextSnapshot?.issueId === "string"
        ? options.contextSnapshot.issueId
        : null;
      calls.push({
        agentId,
        reason: options.reason ?? null,
        idempotencyKey: options.idempotencyKey ?? null,
        issueId,
      });
      if (!issueId) return null;
      if (state.mode === "throw") {
        // A refusal that writes no request row at all (the dispatcher died
        // before recording anything).
        throw new Error("dispatcher refused without a ledger row");
      }
      if (state.mode === "dailyCap") {
        await db.insert(agentWakeupRequests).values({
          companyId: input.companyId,
          agentId,
          source: options.source ?? "on_demand",
          triggerDetail: options.triggerDetail ?? null,
          reason: "heartbeat.daily_run_limit",
          payload: {
            ...(options.payload ?? {}),
            heartbeatSkip: { reason: "heartbeat.daily_run_limit" },
          },
          status: "skipped",
          requestedByActorType: options.requestedByActorType ?? null,
          requestedByActorId: options.requestedByActorId ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
          finishedAt: new Date(),
        });
        return null;
      }
      if (state.holdDispatch && !dispatchHeld) {
        dispatchHeld = true;
        dispatchStarted.resolve();
        await holdDispatch.promise;
      }
      if (state.mode === "parkCarrier") {
        // Scheduling suppression parks the intent on a scheduled-retry
        // carrier: the parked run is created AND bound in the same
        // transaction, exactly like parkSuppressedWakeIntent.
        const carrier = await seedRun({
          companyId: input.companyId,
          agentId,
          issueId,
          status: "scheduled_retry",
          contextSnapshot: {
            issueId,
            taskId: issueId,
            suppressedWakePark: { cause: "scheduling_suppressed", rechecks: 0 },
          },
        });
        if (options.bindRun) await options.bindRun(carrier, db);
        await db.insert(agentWakeupRequests).values({
          companyId: input.companyId,
          agentId,
          source: options.source ?? "on_demand",
          triggerDetail: options.triggerDetail ?? null,
          reason: options.reason ?? null,
          payload: { issueId, taskId: issueId },
          status: "queued",
          requestedByActorType: options.requestedByActorType ?? null,
          requestedByActorId: options.requestedByActorId ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
          runId: carrier.id,
          requestedAt: new Date(),
        });
        return null;
      }
      const run = await seedRun({ companyId: input.companyId, agentId, issueId, status: "queued" });
      try {
        if (options.bindRun) await options.bindRun(run, db);
      } catch (error) {
        // A refused pre-start binding rolls the run-creation transaction
        // back: the run and its wake row never materialize.
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        throw error;
      }
      await db.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId,
        source: options.source ?? "on_demand",
        triggerDetail: options.triggerDetail ?? null,
        reason: options.reason ?? null,
        payload: { issueId, taskId: issueId },
        status: "queued",
        requestedByActorType: options.requestedByActorType ?? null,
        requestedByActorId: options.requestedByActorId ?? null,
        idempotencyKey: options.idempotencyKey ?? null,
        runId: run.id,
        requestedAt: new Date(),
      });
      return run;
    };
    return { state, calls, enqueueWakeup, dispatchStarted: dispatchStarted.promise, releaseDispatch: () => holdDispatch.resolve() };
  }

  /** Returns once another backend is provably waiting on a row lock, so a
   * fenced write is known to be blocked on the concurrent transaction that
   * owns the row. */
  async function waitForRowLockWaiter() {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await db.$client<Array<{ wait_event_type: string | null }>>`
        select wait_event_type
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
      `;
      if (rows.some((row) => row.wait_event_type === "Lock")) return;
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the row lock waiter");
      }
      const poll = Promise.withResolvers<void>();
      setTimeout(poll.resolve, 10);
      await poll.promise;
    }
  }

  async function readIncident(incidentId: string) {
    return db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, incidentId))
      .then((rows) => rows[0]!);
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function readWakeRows(idempotencyKey: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
  }

  async function configRowFor(companyId: string) {
    return db
      .select()
      .from(recoveryEngineerConfigs)
      .where(eq(recoveryEngineerConfigs.companyId, companyId))
      .then((rows) => rows[0]!);
  }

  /**
   * Seeds an interrupted diagnosis claim: the incident is linked to its
   * maintenance issue and one failure generation, but the dispatch never
   * produced a run.
   */
  async function seedClaimedIncident(input: {
    seeded: Awaited<ReturnType<typeof seedCompany>>;
    incidentStatus?: string;
    escalationReason?: string;
    maintenanceStatus?: string;
    maintenanceDescriptor?: { owner: "board"; action: string };
    sourceIssueId?: string;
  }) {
    const incidentId = randomUUID();
    const maintenanceIssueId = randomUUID();
    await db.insert(issues).values({
      id: maintenanceIssueId,
      companyId: input.seeded.companyId,
      title: "Recovery incident deadbeef: Original source task",
      status: input.maintenanceStatus ?? "todo",
      priority: "high",
      assigneeAgentId: input.seeded.recoveryAgentId,
      issueNumber: 300,
      identifier: `${input.seeded.prefix}-300`,
      originKind: "recovery_engineer_incident",
      originId: incidentId,
      ...(input.maintenanceDescriptor ? { unblockDescriptor: input.maintenanceDescriptor } : {}),
    });
    await db.insert(recoveryEngineerIncidents).values({
      id: incidentId,
      companyId: input.seeded.companyId,
      failureFingerprint: `dispatch-fingerprint-${incidentId}`,
      status: input.incidentStatus ?? "diagnosing",
      maintenanceIssueId,
      diagnosisAttemptCount: 1,
      diagnosisRequestedAt: new Date("2026-09-09T10:05:00.000Z"),
      createdAt: new Date("2026-09-09T10:05:00.000Z"),
      ...(input.escalationReason
        ? {
          boardEscalatedAt: new Date("2026-09-09T10:06:00.000Z"),
          boardEscalationReason: input.escalationReason,
        }
        : {}),
    });
    const sourceIssueId = input.sourceIssueId ?? input.seeded.sourceIssueId;
    const sourceIssue = await readIssue(sourceIssueId);
    await db.insert(recoveryEngineerIncidentSources).values({
      companyId: input.seeded.companyId,
      incidentId,
      sourceIssueId,
      generationKey: "run:source-run",
      originalOwnerAgentId: input.seeded.ownerAgentId,
      originalOwnerUserId: null,
      sourceStatus: sourceIssue.status,
      sourceStatusVersion: sourceIssue.statusVersion,
      sourceUpdatedAt: sourceIssue.updatedAt,
      evidence: {},
    });
    return { incidentId, maintenanceIssueId };
  }

  it("parks a suppressed diagnosis dispatch on a bound carrier without spending a charge and converges when the carrier is promoted", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "parkCarrier";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
    });
    await recovery.observeRunTerminal(sourceRun);

    const incidents = await db.select().from(recoveryEngineerIncidents);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!;
    // The claim is durable even though the wake was suppressed: the dispatch
    // intent is the claimed incident row plus the parked carrier pair. A
    // known hold parks the intent — it neither escalates nor charges.
    expect(incident).toMatchObject({ status: "diagnosing", diagnosisAttemptCount: 1 });
    expect(incident.boardEscalatedAt).toBeNull();
    const diagnoseKey = `recovery-engineer:diagnose:${incident.id}`;
    let wakeRows = await readWakeRows(diagnoseKey);
    // One dispatch-claim lease row (already finalized) and one parked
    // carrier wake row.
    expect(wakeRows.filter((row) => row.reason === "recovery_engineer_dispatch_claim")).toHaveLength(1);
    const carrierWake = wakeRows.find((row) => row.reason !== "recovery_engineer_dispatch_claim")!;
    expect(carrierWake.status).toBe("queued");
    expect(carrierWake.runId).not.toBeNull();
    // The carrier was bound before it could ever be promoted: its run is the
    // incident's diagnosis authority, committed with the carrier itself.
    const carrierRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, carrierWake.runId!))
      .then((rows) => rows[0]!);
    expect(carrierRun.status).toBe("scheduled_retry");
    // The carrier carries the durable park marker the classifier reads.
    expect(carrierRun.contextSnapshot).toMatchObject({
      suppressedWakePark: { cause: "scheduling_suppressed" },
    });
    expect(incident.diagnosisRunId).toBe(carrierRun.id);
    // Nothing in the ledger evidences a spent attempt: no failure rows at
    // all — the park is a wait, never an admission.
    expect(
      wakeRows.filter((row) =>
        row.reason !== "recovery_engineer_dispatch_claim" &&
        row.status !== "queued"),
    ).toHaveLength(0);

    const config = await configRowFor(seeded.companyId);
    // The parked carrier is a durable scheduler-owned wait: the sweep is not
    // even selectable (the intent is durably owned by the bound carrier) and
    // stands down without re-deriving, charging, recording, or escalating.
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 0,
      rearmed: 0,
      adopted: 0,
      held: 0,
      exhausted: 0,
    });
    expect(fake.calls).toHaveLength(1);
    const parked = await readIncident(incident.id);
    expect(parked.status).toBe("diagnosing");
    expect(parked.diagnosisRunId).toBe(carrierRun.id);
    expect(parked.boardEscalatedAt).toBeNull();
    expect(await readWakeRows(diagnoseKey)).toHaveLength(2);
    const maintenanceIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, seeded.companyId), ne(issues.id, seeded.sourceIssueId)));
    expect(maintenanceIssues).toHaveLength(1);
    expect(maintenanceIssues[0]!.status).toBe("todo");

    // Promotion re-evaluates the gate and admits the SAME run identity: the
    // promoted run is queued with the park marker cleared, the binding
    // survives, and the fully reconciled incident needs no sweep work and no
    // duplicate dispatch.
    fake.state.mode = "enqueue";
    await db
      .update(heartbeatRuns)
      .set({
        status: "queued",
        contextSnapshot: {
          issueId: carrierRun.contextSnapshot?.issueId,
          taskId: carrierRun.contextSnapshot?.taskId,
        },
      })
      .where(eq(heartbeatRuns.id, carrierRun.id));
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 0,
      rearmed: 0,
      adopted: 0,
    });
    expect(fake.calls).toHaveLength(1);
    const promoted = await readIncident(incident.id);
    expect(promoted.status).toBe("diagnosing");
    expect(promoted.diagnosisRunId).toBe(carrierRun.id);
    wakeRows = await readWakeRows(diagnoseKey);
    expect(wakeRows).toHaveLength(2);
    expect(wakeRows.filter((row) => row.status === "skipped")).toHaveLength(0);
  });

  it("charges only unrecognized enqueue refusals and hands out at the bounded cap", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "throw";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });

    const config = await configRowFor(seeded.companyId);
    // A refusal that never reached the request table is a charge: the sweep
    // appends its own durable failed row, so three passes exhaust the cap
    // and the fourth hands the incident to the board.
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      held: 1,
    });
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      held: 1,
    });
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      held: 1,
    });
    expect(fake.calls).toHaveLength(3);
    const diagnoseKey = `recovery-engineer:diagnose:${incidentId}`;
    expect(
      (await readWakeRows(diagnoseKey)).filter((row) => row.status === "failed"),
    ).toHaveLength(3);

    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      exhausted: 1,
    });
    expect(fake.calls).toHaveLength(3);
    const exhausted = await readIncident(incidentId);
    expect(exhausted.status).toBe("escalated");
    expect(exhausted.boardEscalationReason).toBe("diagnosis_dispatch_attempts_exhausted");
    const maintenance = await readIssue(maintenanceIssueId);
    expect(maintenance.status).toBe("blocked");
    expect(maintenance.unblockDescriptor?.action).toContain("diagnosis_dispatch_attempts_exhausted");

    // Past the cap the incident is no longer actionable: a paused agent that
    // later recovers never silently revives an exhausted dispatch.
    fake.state.mode = "enqueue";
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 0,
      adopted: 0,
      held: 0,
      exhausted: 0,
    });
    expect(fake.calls).toHaveLength(3);
  });

  it("serializes concurrent sweeps for the same dispatch intent into exactly one admitted wake", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId } = await seedClaimedIncident({ seeded });

    const config = await configRowFor(seeded.companyId);
    // Pass A provably holds the intent's committed dispatch claim while its
    // enqueue is in flight; pass B stands down on that fresh lease and
    // completes BEFORE the dispatch is released, so the lease — not a guess
    // about lock timing — is what serializes the passes.
    fake.state.holdDispatch = true;
    const first = recovery.reconcileIncidentDispatches(config);
    await fake.dispatchStarted;
    const second = recovery.reconcileIncidentDispatches(config);
    const secondResult = await second;
    expect(secondResult).toMatchObject({ evaluated: 1, held: 1, rearmed: 0, adopted: 0, exhausted: 0 });
    fake.releaseDispatch();
    const firstResult = await first;

    expect(firstResult).toMatchObject({ evaluated: 1, rearmed: 1, held: 0, adopted: 0, exhausted: 0 });
    // Exactly one enqueue and one real wake row exist for the intent: the
    // loser stood down on the winner's committed claim.
    expect(fake.calls).toHaveLength(1);
    const wakeRows = await readWakeRows(`recovery-engineer:diagnose:${incidentId}`);
    expect(wakeRows.filter((row) => row.reason !== "recovery_engineer_dispatch_claim")).toHaveLength(1);
    expect(wakeRows.filter((row) => row.reason === "recovery_engineer_dispatch_claim" && row.status === "coalesced")).toHaveLength(1);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).not.toBeNull();
    expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, seeded.companyId), ne(issues.id, seeded.sourceIssueId))),
    ).toHaveLength(1);
  });

  it("serializes the original diagnosis dispatch and a concurrent sweep into exactly one wake", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
    });

    // The original producer (claimDiagnosis via run observation) provably
    // holds the intent's committed dispatch claim inside its enqueue; the
    // sweep's re-arm stands down on that same committed lease before the
    // dispatch is released. Sharing the seam is what makes the initial
    // dispatch and the re-arm mutually exclusive.
    fake.state.holdDispatch = true;
    const observed = recovery.observeRunTerminal(sourceRun);
    await fake.dispatchStarted;
    const config = await configRowFor(seeded.companyId);
    const sweep = await recovery.reconcileIncidentDispatches(config);
    expect(sweep).toMatchObject({ evaluated: 1, rearmed: 0, adopted: 0, held: 1, exhausted: 0 });
    fake.releaseDispatch();
    await observed;

    expect(fake.calls).toHaveLength(1);
    const incident = (await db.select().from(recoveryEngineerIncidents))[0]!;
    const diagnoseKey = `recovery-engineer:diagnose:${incident.id}`;
    const wakeRows = await readWakeRows(diagnoseKey);
    expect(wakeRows.filter((row) => row.reason !== "recovery_engineer_dispatch_claim")).toHaveLength(1);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).not.toBeNull();
    // The sweep re-validated against the producer's committed claim and
    // stood down without writing a duplicate.
  });

  it("preserves a parked scheduled-retry carrier wake without charging or recording it", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    const carrierRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      issueId: maintenanceIssueId,
      status: "scheduled_retry",
      createdAt: new Date("2026-09-09T10:07:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "recovery_engineer_diagnose",
      payload: { issueId: maintenanceIssueId, taskId: maintenanceIssueId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "recovery_engineer",
      idempotencyKey: `recovery-engineer:diagnose:${incidentId}`,
      runId: carrierRun.id,
      requestedAt: new Date(),
    });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      adopted: 1,
    });

    // The carrier is a durable scheduler-owned wait: the sweep stands down,
    // records nothing as the diagnosis run, charges nothing, and escalates
    // nothing.
    expect(fake.calls).toHaveLength(0);
    const incident = await readIncident(incidentId);
    expect(incident.diagnosisRunId).toBeNull();
    expect(incident.status).toBe("diagnosing");
    expect(incident.boardEscalatedAt).toBeNull();
    expect(await readWakeRows(`recovery-engineer:diagnose:${incidentId}`)).toHaveLength(1);
  });

  it("re-arms a claimed diagnosis after a process restart without duplicating the wake", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
    });

    const rearmed = await readIncident(incidentId);
    expect(rearmed.status).toBe("diagnosing");
    expect(rearmed.diagnosisRunId).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    const wakeRows = await readWakeRows(`recovery-engineer:diagnose:${incidentId}`);
    // One finalized dispatch-claim lease plus the real queued wake row.
    expect(wakeRows).toHaveLength(2);
    expect(wakeRows.filter((row) => row.reason === "recovery_engineer_dispatch_claim")).toHaveLength(1);

    // A recorded live dispatch no longer qualifies as an orphan.
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 0,
      rearmed: 0,
    });
    expect(fake.calls).toHaveLength(1);
    expect((await readIncident(incidentId)).diagnosisRunId).toBe(rearmed.diagnosisRunId);
    expect(await readWakeRows(`recovery-engineer:diagnose:${incidentId}`)).toHaveLength(2);
  });

  it("completes an interrupted activation whose maintenance issue was created but never claimed", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const incidentId = randomUUID();
    const maintenanceIssueId = randomUUID();
    await db.insert(issues).values({
      id: maintenanceIssueId,
      companyId: seeded.companyId,
      title: "Recovery incident cafe1234: Original source task",
      status: "todo",
      priority: "high",
      assigneeAgentId: seeded.recoveryAgentId,
      issueNumber: 301,
      identifier: `${seeded.prefix}-301`,
      originKind: "recovery_engineer_incident",
      originId: incidentId,
    });
    await db.insert(recoveryEngineerIncidents).values({
      id: incidentId,
      companyId: seeded.companyId,
      failureFingerprint: `orphan-fingerprint-${incidentId}`,
      status: "suspected",
      maintenanceIssueId,
      diagnosisAttemptCount: 0,
      createdAt: new Date(Date.now() - 20 * 60 * 1_000),
    });
    const sourceIssue = await readIssue(seeded.sourceIssueId);
    await db.insert(recoveryEngineerIncidentSources).values({
      companyId: seeded.companyId,
      incidentId,
      sourceIssueId: seeded.sourceIssueId,
      generationKey: "blocked:4",
      originalOwnerAgentId: seeded.ownerAgentId,
      originalOwnerUserId: null,
      sourceStatus: sourceIssue.status,
      sourceStatusVersion: sourceIssue.statusVersion,
      sourceUpdatedAt: sourceIssue.updatedAt,
      evidence: {},
    });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
    });

    const healed = await readIncident(incidentId);
    expect(healed).toMatchObject({
      status: "diagnosing",
      diagnosisAttemptCount: 1,
      maintenanceIssueId,
    });
    expect(healed.diagnosisRunId).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      idempotencyKey: `recovery-engineer:diagnose:${incidentId}`,
      issueId: maintenanceIssueId,
    });
    // The interrupted activation never mints a second incident or a second
    // maintenance issue.
    expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, seeded.companyId), ne(issues.id, seeded.sourceIssueId))),
    ).toHaveLength(1);
  });

  it("adopts a durable deferred wake instead of re-enqueueing it", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "recovery_engineer_diagnose",
      payload: { issueId: maintenanceIssueId, taskId: maintenanceIssueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: "recovery_engineer",
      idempotencyKey: `recovery-engineer:diagnose:${incidentId}`,
    });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      adopted: 1,
    });

    expect(fake.calls).toHaveLength(0);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).toBeNull();
    expect(await readWakeRows(`recovery-engineer:diagnose:${incidentId}`)).toHaveLength(1);
  });

  it("routes an adopted wake whose run already failed into the exact bounded outcome and stops re-arming", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    const failedDiagnosisRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      issueId: maintenanceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Recovery diagnosis failed",
      createdAt: new Date("2026-09-09T10:07:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "recovery_engineer_diagnose",
      payload: { issueId: maintenanceIssueId, taskId: maintenanceIssueId },
      status: "claimed",
      requestedByActorType: "system",
      requestedByActorId: "recovery_engineer",
      idempotencyKey: `recovery-engineer:diagnose:${incidentId}`,
      runId: failedDiagnosisRun.id,
      claimedAt: new Date("2026-09-09T10:06:30.000Z"),
    });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
    });

    const incident = await readIncident(incidentId);
    expect(incident.diagnosisRunId).toBe(failedDiagnosisRun.id);
    // The run happened, so its outcome — not another dispatch — is the
    // authoritative state: one bounded board escalation with the exact
    // reason, and no further re-arm attempts.
    expect(incident.status).toBe("escalated");
    expect(incident.boardEscalationReason).toBe("recovery_run_failed");
    const maintenance = await readIssue(maintenanceIssueId);
    expect(maintenance.status).toBe("blocked");
    expect(maintenance.unblockDescriptor?.action).toContain("recovery_run_failed");
    expect(fake.calls).toHaveLength(0);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 0,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps a human-gated incident and its exact board descriptor untouched by the sweep", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const descriptor: { owner: "board"; action: string } = {
      owner: "board",
      action: "Resolve the confirmed human_gate before any source resume.",
    };
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({
      seeded,
      incidentStatus: "gated",
      maintenanceStatus: "blocked",
      maintenanceDescriptor: descriptor,
    });
    const diagnosisRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      issueId: maintenanceIssueId,
      status: "succeeded",
      createdAt: new Date("2026-09-09T10:07:00.000Z"),
    });
    await db
      .update(recoveryEngineerIncidents)
      .set({
        diagnosisRunId: diagnosisRun.id,
        classification: "human_gate",
        confirmedAt: new Date("2026-09-09T10:08:00.000Z"),
      })
      .where(eq(recoveryEngineerIncidents.id, incidentId));

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 0,
    });

    expect(fake.calls).toHaveLength(0);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("gated");
    expect(incident.classification).toBe("human_gate");
    const maintenance = await readIssue(maintenanceIssueId);
    expect(maintenance.status).toBe("blocked");
    expect(maintenance.unblockDescriptor).toEqual(descriptor);
  });

  it("gives a diagnosis success without its required artifact a stable bounded board ownership", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
    });
    await recovery.observeRunTerminal(sourceRun);
    const incident = (await db.select().from(recoveryEngineerIncidents))[0]!;
    expect(incident.diagnosisRunId).not.toBeNull();

    // The diagnosis run terminalizes successfully without ever recording a
    // diagnosis: one bounded escalation owns the outcome durably and exactly.
    const succeeded = await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        livenessState: "advanced",
        lastUsefulActionAt: new Date("2026-09-09T10:09:00.000Z"),
        finishedAt: new Date("2026-09-09T10:09:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, incident.diagnosisRunId!))
      .returning()
      .then((rows) => rows[0]!);
    await recovery.observeRunTerminal(succeeded);

    const escalated = await readIncident(incident.id);
    expect(escalated.status).toBe("escalated");
    expect(escalated.boardEscalationReason).toBe("diagnosis_run_succeeded_without_diagnosis");
    expect(escalated.repairIssueId).toBeNull();
    const escalatedAt = escalated.boardEscalatedAt;
    expect(escalatedAt).not.toBeNull();
    const maintenance = await readIssue(escalated.maintenanceIssueId!);
    expect(maintenance.status).toBe("blocked");
    expect(maintenance.unblockDescriptor?.action).toContain("diagnosis_run_succeeded_without_diagnosis");
    expect(fake.calls).toHaveLength(1);

    // Re-observing the same terminal run changes nothing: the ownership is
    // stable, with no duplicate escalation timestamp and no duplicate wake.
    await recovery.observeRunTerminal(succeeded);
    const again = await readIncident(incident.id);
    expect(again.boardEscalatedAt).toEqual(escalatedAt);
    expect(again.boardEscalationReason).toBe("diagnosis_run_succeeded_without_diagnosis");
    expect(fake.calls).toHaveLength(1);

    // A materially different recorded reason is refreshed to the exact
    // current one — including this flow's own descriptor — without minting
    // new work or touching the escalation timestamp.
    await db
      .update(recoveryEngineerIncidents)
      .set({ boardEscalationReason: "recovery_run_failed" })
      .where(eq(recoveryEngineerIncidents.id, incident.id));
    await recovery.observeRunTerminal(succeeded);
    const refreshed = await readIncident(incident.id);
    expect(refreshed.boardEscalationReason).toBe("diagnosis_run_succeeded_without_diagnosis");
    expect(refreshed.boardEscalatedAt).toEqual(escalatedAt);
    const refreshedMaintenance = await readIssue(escalated.maintenanceIssueId!);
    expect(refreshedMaintenance.status).toBe("blocked");
    expect(refreshedMaintenance.unblockDescriptor?.action).toContain(
      "diagnosis_run_succeeded_without_diagnosis",
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("leaves a foreign board wait untouched while re-arming the dispatch it parked", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const descriptor: { owner: "board"; action: string } = {
      owner: "board",
      action: "Board decision pending on the underlying outage.",
    };
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({
      seeded,
      incidentStatus: "escalated",
      escalationReason: "diagnosis_enqueue_failed",
      maintenanceStatus: "blocked",
      maintenanceDescriptor: descriptor,
    });

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
    });

    expect(fake.calls).toHaveLength(1);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).not.toBeNull();
    // The descriptor a human wrote is not this flow's escalation text: the
    // re-arm never rewrites it, and the issue stays parked for its owner.
    const maintenance = await readIssue(maintenanceIssueId);
    expect(maintenance.status).toBe("blocked");
    expect(maintenance.unblockDescriptor).toEqual(descriptor);
  });

  it("re-derives a gate-cancelled park carrier as a stale intent instead of escalating a never-executed run", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "enqueue";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    // A suppressed dispatch parked a bound carrier (exactly like the park
    // path), and the scheduler then cancelled that carrier at promotion
    // because a gate changed — the run and its wake row are cancelled while
    // the durable park marker stays on the run.
    const carrierRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      issueId: maintenanceIssueId,
      status: "scheduled_retry",
      contextSnapshot: {
        issueId: maintenanceIssueId,
        taskId: maintenanceIssueId,
        suppressedWakePark: { cause: "scheduling_suppressed", rechecks: 2 },
      },
      createdAt: new Date("2026-09-09T10:07:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "recovery_engineer_diagnose",
      payload: { issueId: maintenanceIssueId, taskId: maintenanceIssueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "recovery_engineer",
      idempotencyKey: `recovery-engineer:diagnose:${incidentId}`,
      runId: carrierRun.id,
      requestedAt: new Date(),
    });
    await db
      .update(recoveryEngineerIncidents)
      .set({ diagnosisRunId: carrierRun.id })
      .where(eq(recoveryEngineerIncidents.id, incidentId));
    // cancelScheduledRetryForGate: the promotion gate cancelled the carrier
    // (issue/assignee/agent gate changed) — the run stays cancelled WITH its
    // durable park marker, and the wake row is cancelled alongside it.
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date("2026-09-09T10:09:00.000Z"),
        error: "Cancelled because the issue was reassigned before the scheduled retry became due",
        errorCode: "issue_reassigned",
      })
      .where(eq(heartbeatRuns.id, carrierRun.id));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: new Date("2026-09-09T10:09:00.000Z"),
        error: "Cancelled because the issue was reassigned before the scheduled retry became due",
      })
      .where(eq(agentWakeupRequests.runId, carrierRun.id));

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
      adopted: 0,
      held: 0,
      exhausted: 0,
    });

    // The gate-cancelled carrier was never execution evidence: the sweep
    // cleared its stale binding, re-derived the dispatch under the same key,
    // and never routed the cancelled run through the participant-outcome
    // escalation.
    expect(fake.calls).toHaveLength(1);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).not.toBeNull();
    expect(incident.diagnosisRunId).not.toBe(carrierRun.id);
    expect(incident.boardEscalatedAt).toBeNull();
    expect(incident.boardEscalationReason).toBeNull();
    const wakeRows = await readWakeRows(`recovery-engineer:diagnose:${incidentId}`);
    expect(wakeRows.filter((row) => row.status === "failed")).toHaveLength(0);
    // The cancelled carrier row is itself the charged stale intent (a
    // terminal run the classifier counts), and the new wake is the only live
    // one.
    expect(wakeRows.filter((row) => row.runId === carrierRun.id && row.status === "cancelled")).toHaveLength(1);
    expect(wakeRows.filter((row) => row.status === "queued" && row.runId !== carrierRun.id)).toHaveLength(1);
  });

  it("keeps a terminal board outcome ahead of a concurrent attempt-exhaustion escalation", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "throw";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    const diagnoseKey = `recovery-engineer:diagnose:${incidentId}`;
    const gateHold = Promise.withResolvers<void>();
    let gateReleased = false;
    const gateOpen = () => {
      if (!gateReleased) {
        gateReleased = true;
        gateHold.resolve();
      }
    };

    const config = await configRowFor(seeded.companyId);
    // Spend the cap: three unrecognized refusals become three durable
    // failed-attempt rows.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recovery.reconcileIncidentDispatches(config);
    }
    expect(
      (await readWakeRows(diagnoseKey)).filter((row) => row.status === "failed"),
    ).toHaveLength(3);

    // A board diagnosis opens its transaction and holds the incident row
    // lock uncommitted — exactly the concurrent transition the stale sweep
    // used to clobber with an attempts-exhausted escalation.
    const boardDiagnosis = db.transaction(async (tx) => {
      await tx
        .update(recoveryEngineerIncidents)
        .set({
          status: "gated",
          classification: "human_gate",
          confirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recoveryEngineerIncidents.id, incidentId));
      // Hold the transaction open until the sweep is provably blocked on
      // the incident row inside its own attempt-cap escalation.
      await gateHold.promise;
    });
    try {
      // The sweep's cap decision reads the pre-terminal state (the board
      // transaction is uncommitted), evaluates the cap as exhausted, and
      // blocks on the incident row inside its fenced escalation UPDATE.
      const sweep = recovery.reconcileIncidentDispatches(config);
      await waitForRowLockWaiter();
      gateOpen();
      const [sweepResult] = await Promise.all([sweep, boardDiagnosis]);

      // The fence held: the terminal outcome won, no attempts-exhausted
      // escalation was written, and the sweep stood down.
      expect(sweepResult).toMatchObject({ evaluated: 1, exhausted: 0, held: 1 });
      const incident = await readIncident(incidentId);
      expect(incident.status).toBe("gated");
      expect(incident.classification).toBe("human_gate");
      expect(incident.boardEscalatedAt).toBeNull();
      expect(incident.boardEscalationReason).toBeNull();
      const maintenance = await readIssue(maintenanceIssueId);
      expect(maintenance.status).toBe("todo");
      expect(maintenance.unblockDescriptor).toBeNull();
      expect(fake.calls).toHaveLength(3);
    } finally {
      gateOpen();
      await boardDiagnosis.catch(() => {});
    }
  });

  it("re-arms a verified activation whose instruction wake never materialized", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    // The primary activation path left the incident verified with a
    // confirmed activation and no resume run: the instruction wake never
    // materialized (an enqueue failure or a crash between activation and
    // dispatch).
    await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "verified",
        verifiedAt: new Date("2026-09-09T10:09:00.000Z"),
        activatedRepairCommit: "cafe1234",
        repairCommit: "cafe1234",
        activatedAt: new Date("2026-09-09T10:10:00.000Z"),
        activationEvidence: "activated in the live runtime",
      })
      .where(eq(recoveryEngineerIncidents.id, incidentId));
    const activatedKey = `recovery-engineer:activated:${incidentId}:cafe1234`;

    const config = await configRowFor(seeded.companyId);
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
      held: 0,
      exhausted: 0,
    });

    // The verified activation state is re-armable: exactly one instruction
    // wake was minted under the activation key, the incident stays verified,
    // and nothing was escalated or charged.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      agentId: seeded.recoveryAgentId,
      reason: "recovery_engineer_activated",
      idempotencyKey: activatedKey,
      issueId: maintenanceIssueId,
    });
    let incident = await readIncident(incidentId);
    expect(incident.status).toBe("verified");
    expect(incident.boardEscalatedAt).toBeNull();
    const wakeRows = await readWakeRows(activatedKey);
    expect(wakeRows.filter((row) => row.reason !== "recovery_engineer_dispatch_claim" && row.status === "queued")).toHaveLength(1);
    const maintenance = await readIssue(maintenanceIssueId);
    expect(maintenance.status).toBe("in_progress");

    // The live instruction wake owns the dispatch durably: the next sweep
    // converges on the ledger row without minting a duplicate.
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
      held: 0,
    });
    expect(fake.calls).toHaveLength(1);
    incident = await readIncident(incidentId);
    expect(incident.status).toBe("verified");
    expect(incident.boardEscalatedAt).toBeNull();
    expect(await readWakeRows(activatedKey)).toHaveLength(2);
  });

  it("waits on heartbeat daily caps without spending attempts and admits once the cap lifts", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "dailyCap";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId } = await seedClaimedIncident({ seeded });
    const diagnoseKey = `recovery-engineer:diagnose:${incidentId}`;

    const config = await configRowFor(seeded.companyId);
    // Every daily-cap refusal is a recognized hold: the intent parks without
    // a charge, without an escalation, and without a re-derivation while the
    // hold is fresh — three caps in a row never exhaust the attempt budget.
    for (let pass = 0; pass < 3; pass += 1) {
      await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
        evaluated: 1,
        held: 1,
        exhausted: 0,
      });
      await db
        .update(agentWakeupRequests)
        .set({ requestedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) })
        .where(and(eq(agentWakeupRequests.idempotencyKey, diagnoseKey), eq(agentWakeupRequests.status, "skipped")));
    }
    expect(fake.calls).toHaveLength(3);
    expect(
      (await readWakeRows(diagnoseKey)).filter((row) => row.reason === "heartbeat.daily_run_limit"),
    ).toHaveLength(3);
    expect(
      (await readWakeRows(diagnoseKey)).filter((row) => row.status === "failed"),
    ).toHaveLength(0);
    let incident = await readIncident(incidentId);
    expect(incident.boardEscalatedAt).toBeNull();
    expect(incident.diagnosisRunId).toBeNull();

    // Once the cap resets, the next backoff-eligible pass admits the
    // dispatch in place — still the first real attempt of the intent.
    fake.state.mode = "enqueue";
    await expect(recovery.reconcileIncidentDispatches(config)).resolves.toMatchObject({
      evaluated: 1,
      rearmed: 1,
      exhausted: 0,
    });
    expect(fake.calls).toHaveLength(4);
    incident = await readIncident(incidentId);
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisRunId).not.toBeNull();
    const wakeRows = await readWakeRows(diagnoseKey);
    expect(wakeRows.filter((row) => row.reason === "heartbeat.daily_run_limit")).toHaveLength(3);
    expect(wakeRows.filter((row) => row.status === "queued")).toHaveLength(1);
  });

  it("dispatches a real heartbeat wake on a single-connection pool and admits a fast participant diagnosis", async () => {
    const seeded = await seedCompany();
    // One shared database connection: the old design held its decision
    // transaction open across the real enqueueWakeup, which needs the same
    // pool again — the dispatch deadlocked at this size. The seam's
    // decision transaction must have committed before the dispatcher runs.
    const pool1 = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const heartbeat = heartbeatService(pool1);
    const recovery = recoveryEngineerService(pool1, { enqueueWakeup: heartbeat.enqueueWakeup });
    await db
      .update(agents)
      .set({ adapterType: BLOCKED_POOL_ONE_ADAPTER })
      .where(eq(agents.id, seeded.recoveryAgentId));
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
    });

    try {
    await recovery.observeRunTerminal(sourceRun);

    const incident = (await db.select().from(recoveryEngineerIncidents))[0]!;
    expect(incident.status).toBe("diagnosing");
    expect(incident.diagnosisAttemptCount).toBe(1);
    expect(incident.diagnosisRunId).not.toBeNull();
    const diagnosisRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, incident.diagnosisRunId!))
      .then((rows) => rows[0]!);
    // The dispatcher materialized a real run under the wake's own
    // idempotency key, and the binding committed with the run row itself.
    expect(["queued", "running"]).toContain(diagnosisRun.status);

    // A fast participant records its diagnosis on its first action: the run
    // authority was bound before the dispatcher could claim the run, so the
    // single-diagnosis-run check admits it with no sweep in between.
    await expect(recovery.recordAction(incident.maintenanceIssueId!, {
      action: "diagnose",
      classification: "infrastructure",
      hypothesis: "The source runner crashed on a transient adapter error.",
      evidence: ["adapter_failed observed on the source run"],
    }, {
      actorType: "agent",
      agentId: seeded.recoveryAgentId,
      userId: null,
      runId: diagnosisRun.id,
      board: false,
    })).resolves.toMatchObject({ status: "diagnosed", diagnosisRunId: diagnosisRun.id });

    // Release the admitted run and let its execution drain before teardown,
    // so no late executor write races the suite cleanup.
    } finally {
    poolOneRunGate.resolve();
    await heartbeat.drainActiveRunExecutions();
    await pool1.$client.end();
    }
  });

  it("replaces an expired diagnosis dispatch lease with exactly one executable run and preserves the replacement claim", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "enqueue";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId } = await seedClaimedIncident({ seeded });
    const diagnoseKey = `recovery-engineer:diagnose:${incidentId}`;

    const config = await configRowFor(seeded.companyId);
    // Pass A provably holds its enqueue in flight past its claim's
    // staleness; the expired lease is then replaced under the same key.
    fake.state.holdDispatch = true;
    const first = recovery.reconcileIncidentDispatches(config);
    await fake.dispatchStarted;
    const staleClaims = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.idempotencyKey, diagnoseKey),
        eq(agentWakeupRequests.reason, "recovery_engineer_dispatch_claim"),
        eq(agentWakeupRequests.status, "claimed"),
      ));
    expect(staleClaims).toHaveLength(1);
    await db
      .update(agentWakeupRequests)
      .set({ claimedAt: new Date(Date.now() - 3 * 60 * 1_000) })
      .where(eq(agentWakeupRequests.id, staleClaims[0]!.id));

    // Pass B takes over the expired lease: converts it into the
    // failed-attempt row the cap counts, commits a replacement claim, and
    // its dispatch is the one executable run.
    const second = await recovery.reconcileIncidentDispatches(config);
    expect(second).toMatchObject({ evaluated: 1, rearmed: 1, held: 0, exhausted: 0 });
    const replacedIncident = await readIncident(incidentId);
    expect(replacedIncident.diagnosisRunId).not.toBeNull();
    const replacementRunId = replacedIncident.diagnosisRunId!;

    // The late first producer resumes; its enqueue is fenced on its own
    // replaced claim and rolls back without producing an executable run or
    // touching the replacement lease.
    fake.releaseDispatch();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ evaluated: 1, held: 1, rearmed: 0, exhausted: 0 });

    expect(fake.calls).toHaveLength(2);
    const incident = await readIncident(incidentId);
    expect(incident.diagnosisRunId).toBe(replacementRunId);
    expect(incident.boardEscalatedAt).toBeNull();
    const wakeRows = await readWakeRows(diagnoseKey);
    // The replaced lease is the durable failed attempt; the replacement
    // lease stayed coalesced on ITS OWN run; the only live wake is the
    // replacement's.
    expect(wakeRows.filter((row) => row.status === "failed" && row.reason === "recovery_engineer_dispatch_enqueue_failed")).toHaveLength(1);
    const replacementClaims = wakeRows.filter((row) =>
      row.reason === "recovery_engineer_dispatch_claim" && row.status === "coalesced");
    expect(replacementClaims).toHaveLength(1);
    expect(replacementClaims[0]!.runId).toBe(replacementRunId);
    expect(wakeRows.filter((row) => row.status === "queued")).toHaveLength(1);
    expect(wakeRows.filter((row) => row.status === "queued")[0]!.runId).toBe(replacementRunId);
  });

  it("fences a late activation enqueue behind its replaced claim without a run-column fence", async () => {
    const seeded = await seedCompany();
    const fake = createWakeFake({ companyId: seeded.companyId });
    fake.state.mode = "enqueue";
    const recovery = recoveryEngineerService(db, { enqueueWakeup: fake.enqueueWakeup });
    const { incidentId, maintenanceIssueId } = await seedClaimedIncident({ seeded });
    await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "verified",
        verifiedAt: new Date("2026-09-09T10:09:00.000Z"),
        activatedRepairCommit: "cafe1234",
        repairCommit: "cafe1234",
        activatedAt: new Date("2026-09-09T10:10:00.000Z"),
        activationEvidence: "activated in the live runtime",
      })
      .where(eq(recoveryEngineerIncidents.id, incidentId));
    const activatedKey = `recovery-engineer:activated:${incidentId}:cafe1234`;

    const config = await configRowFor(seeded.companyId);
    // Pass A's instruction-wake enqueue is held in flight past its lease.
    fake.state.holdDispatch = true;
    const first = recovery.reconcileIncidentDispatches(config);
    await fake.dispatchStarted;
    const staleClaims = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.idempotencyKey, activatedKey),
        eq(agentWakeupRequests.reason, "recovery_engineer_dispatch_claim"),
        eq(agentWakeupRequests.status, "claimed"),
      ));
    expect(staleClaims).toHaveLength(1);
    await db
      .update(agentWakeupRequests)
      .set({ claimedAt: new Date(Date.now() - 3 * 60 * 1_000) })
      .where(eq(agentWakeupRequests.id, staleClaims[0]!.id));

    // Pass B re-claims the expired lease and delivers the one instruction
    // wake; the intent has no incident run column, so the exact-current
    // claim itself is the admission fence.
    const second = await recovery.reconcileIncidentDispatches(config);
    expect(second).toMatchObject({ evaluated: 1, rearmed: 1, exhausted: 0 });

    // The late first producer is fenced by its replaced claim and rolls
    // back: exactly one instruction wake exists, owned by the replacement.
    fake.releaseDispatch();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ evaluated: 1, held: 1, rearmed: 0 });

    expect(fake.calls).toHaveLength(2);
    const incident = await readIncident(incidentId);
    expect(incident.status).toBe("verified");
    expect(incident.boardEscalatedAt).toBeNull();
    const wakeRows = await readWakeRows(activatedKey);
    expect(wakeRows.filter((row) => row.reason === "recovery_engineer_dispatch_claim" && row.status === "coalesced")).toHaveLength(1);
    expect(wakeRows.filter((row) => row.reason === "recovery_engineer_dispatch_enqueue_failed" && row.status === "failed")).toHaveLength(1);
    expect(wakeRows.filter((row) => row.reason !== "recovery_engineer_dispatch_claim" && row.status === "queued")).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, maintenanceIssueId)))[0]!.status).toBe("in_progress");
  });
});
