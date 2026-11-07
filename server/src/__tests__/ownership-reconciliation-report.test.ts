import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  sandboxCreationOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { currentControllerBootId, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerOwnershipReconciliationWork } from "../services/native-runtime/native-finalization-reconciler.js";
import {
  createOwnershipReportState,
  OWNERSHIP_INVARIANT_VIOLATION_ACTION,
  runOwnershipReconciliationPass,
  type OwnershipReport,
} from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const kindReport = (report: OwnershipReport, kind: string) => report.kinds.find(entry => entry.kind === kind)!;
const rules = (report: OwnershipReport, kind: string) =>
  report.violations.filter(violation => violation.kind === kind).map(violation => violation.rule).sort();

describe("report-only ownership reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("ownership-reconciliation-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 120_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  beforeEach(async () => {
    await db.execute(sql`truncate activity_log, agent_wakeup_requests, sandbox_creation_operations, environment_leases,
      native_run_finalizations, heartbeat_runs, issues, agents, companies cascade`);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ownership fixture", issuePrefix: "OWN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  });

  /** One record per owner class: alive here, provably gone, unprovable, unowned. */
  async function seed() {
    ids = {
      liveRun: randomUUID(), deadRun: randomUUID(), debtRun: randomUUID(),
      liveIssue: randomUUID(), stalledIssue: randomUUID(),
      orphanLease: randomUUID(), unownedCleanup: randomUUID(), foreignIntent: randomUUID(), wake: randomUUID(),
    };
    await db.insert(issues).values([
      { id: ids.liveIssue, companyId, title: "Live", status: "in_progress", assigneeAgentId: agentId },
      { id: ids.stalledIssue, companyId, title: "Stalled", status: "in_progress", assigneeAgentId: agentId,
        updatedAt: minutesAgo(30) },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: ids.liveRun, companyId, agentId, issueId: ids.liveIssue, status: "running", invocationSource: "manual",
        runtimeMode: "native", nativeIssueId: ids.liveIssue },
      { id: ids.deadRun, companyId, agentId, status: "failed", invocationSource: "manual", finishedAt: minutesAgo(1) },
      { id: ids.debtRun, companyId, agentId, status: "succeeded", invocationSource: "manual", finishedAt: minutesAgo(20),
        costAccountingPending: true },
    ]);
    // A fresh native claim held by this process.
    await db.insert(nativeRunFinalizations).values({ runId: ids.liveRun, companyId, issueId: ids.liveIssue,
      phase: "observed", leaseOwner: `${currentControllerBootId()}:1:token`, leaseExpiresAt: new Date(Date.now() + 60_000),
      controllerBootId: currentControllerBootId(), controllerPid: process.pid, controllerGeneration: 1 });
    await db.insert(environmentLeases).values([
      // An active lease whose run already failed: the owner is provably gone.
      { id: ids.orphanLease, companyId, heartbeatRunId: ids.deadRun, status: "active" },
      // A cleanup obligation that names no owner.
      { id: ids.unownedCleanup, companyId, status: "pending_cleanup", metadata: { pendingCleanupRetryAttempts: 1 } },
    ]);
    // A creation intent stamped by a process in another PID space.
    await db.insert(sandboxCreationOperations).values({ id: ids.foreignIntent, companyId,
      originalEnvironmentId: randomUUID(), runId: ids.deadRun, requestKey: "fixture", provider: "fixture",
      driverKey: "fixture", state: "pending", config: {}, nextAttemptAt: new Date(),
      metadata: { creationController: { bootId: "other-boot", pid: 1, hostHash: "another-pid-space",
        processStartedAt: "2026-11-01T00:00:00.000Z" } } });
    // A wake request ended terminally on a temporary refusal.
    await db.insert(agentWakeupRequests).values({ id: ids.wake, companyId, agentId, source: "assignment",
      status: "skipped", error: "Company budget hold: admission paused" });
  }

  async function snapshot() {
    return {
      leases: await db.select({ id: environmentLeases.id, status: environmentLeases.status, metadata: environmentLeases.metadata })
        .from(environmentLeases).orderBy(environmentLeases.id),
      claims: await db.select().from(nativeRunFinalizations),
      intents: await db.select({ id: sandboxCreationOperations.id, state: sandboxCreationOperations.state }).from(sandboxCreationOperations),
      issues: await db.select({ id: issues.id, status: issues.status, executionRunId: issues.executionRunId }).from(issues).orderBy(issues.id),
      runs: await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, pending: heartbeatRuns.costAccountingPending })
        .from(heartbeatRuns).orderBy(heartbeatRuns.id),
    };
  }

  it("registers every section-C kind once, with no settle path", () => {
    const names = OWNABLE_KINDS.map(kind => kind.id);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(OWNABLE_KINDS.every(kind => kind.settle === null)).toBe(true);
    expect(OWNABLE_KINDS.filter(kind => !kind.listInProgress).every(kind => kind.coverageGap)).toBe(true);
  });

  it("classifies each owner and reports invariant violations without changing any record", async () => {
    await seed();
    const before = await snapshot();
    const state = createOwnershipReportState();

    const first = await runOwnershipReconciliationPass(db, { state });

    expect(kindReport(first, "native_executor_claim")).toMatchObject({ inProgress: 1,
      verdicts: { alive: 1, gone: 0, unprovable: 0 }, reasons: { current_process: 1 } });
    expect(kindReport(first, "environment_run_lease_active")).toMatchObject({ inProgress: 1,
      verdicts: { gone: 1 }, reasons: { owner_run_terminal: 1 } });
    expect(kindReport(first, "environment_pending_cleanup")).toMatchObject({ inProgress: 1,
      verdicts: { unprovable: 1 }, reasons: { no_owner_stamp: 1 } });
    // A different PID space is never proof.
    expect(currentProcessSpaceHash()).not.toBe("another-pid-space");
    expect(kindReport(first, "sandbox_creation_intent")).toMatchObject({ inProgress: 1,
      verdicts: { unprovable: 1 }, reasons: { different_process_space: 1 } });
    expect(kindReport(first, "run_accounting_debt")).toMatchObject({ inProgress: 1 });

    expect(rules(first, "environment_pending_cleanup")).toEqual(["I1_owned"]);
    // I2 needs the owner proven gone on two consecutive passes.
    expect(rules(first, "environment_run_lease_active")).toEqual([]);
    expect(rules(first, "run_accounting_debt")).toEqual(["I3_admission_independent"]);
    expect(rules(first, "wake_request")).toEqual(["I4_exactly_once_intent"]);
    expect(first.violations.filter(violation => violation.rule === "I7_visible_next_action")
      .map(violation => violation.recordId)).toEqual([ids.stalledIssue]);
    expect(Object.keys(first.coverageGaps)).toEqual(["I5_work_based_budgets", "I6_generation_fencing", "I8_fast_turns"]);

    const second = await runOwnershipReconciliationPass(db, { state });
    expect(rules(second, "environment_run_lease_active")).toEqual(["I2_settled"]);
    expect(second.newViolations.map(violation => `${violation.rule}:${violation.kind}`)).toEqual(["I2_settled:environment_run_lease_active"]);

    // Report-only: nothing was settled, released or retried.
    expect(await snapshot()).toEqual(before);

    const rows = await db.select({ entityId: activityLog.entityId, actorId: activityLog.actorId, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.action, OWNERSHIP_INVARIANT_VIOLATION_ACTION));
    // Each violation is written once per process, on the pass that first sees it.
    const written = [...first.newViolations, ...second.newViolations];
    expect(rows).toHaveLength(written.length);
    expect(rows.every(row => row.actorId === "ownership-reconciler")).toBe(true);
    expect(rows.map(row => `${(row.details as Record<string, unknown>).rule}:${row.entityId}`).sort())
      .toEqual(written.map(violation => `${violation.rule}:${violation.recordId}`).sort());
    expect(rows.find(row => row.entityId === ids.orphanLease)?.details).toMatchObject({
      rule: "I2_settled", kind: "environment_run_lease_active", reason: "owner_run_terminal", runId: ids.deadRun, mode: "report_only",
    });
  });

  it("writes nothing when recording is off", async () => {
    await seed();
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.length).toBeGreaterThan(0);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("goes quiet with nothing in progress and follows up while records change", async () => {
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const reports: OwnershipReport[] = [];
    const worker = registerOwnershipReconciliationWork(db, coordinator, () => true, { onReport: report => reports.push(report) });
    try {
      await worker.ready;
      expect(reports).toHaveLength(1);
      expect(reports[0]!.inProgress).toBe(0);
      // An idle instance: no deadline, so no SQL until a producer signals.
      expect(coordinator.nextWakeAt()).toBeNull();

      await seed();
      worker.wake();
      await expect.poll(() => reports.length, { timeout: 60_000, interval: 100 }).toBe(2);
      expect(reports[1]!.inProgress).toBeGreaterThan(0);
      expect(coordinator.nextWakeAt()).not.toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await worker.stop();
      await coordinator.stop();
    }
  }, 90_000);
});
