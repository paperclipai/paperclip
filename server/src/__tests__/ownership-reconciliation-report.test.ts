import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  budgetPolicies,
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
  recheckSettlingKinds,
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

  let home: string;
  let orphanSpool: string;

  beforeAll(async () => {
    // Spool kinds read the instance root; never let a test read a real instance.
    home = await mkdtemp(join(tmpdir(), "ownership-report-home-"));
    orphanSpool = join(home, "orphan-spool");
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR", orphanSpool);
    if (!external) database = await startEmbeddedPostgresTestDatabase("ownership-reconciliation-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(orphanSpool, { recursive: true, force: true });
    await db.execute(sql`truncate budget_policies, activity_log, agent_wakeup_requests, sandbox_creation_operations, environment_leases,
      native_run_finalizations, heartbeat_runs, issues, agents, companies cascade`);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ownership fixture", issuePrefix: "OWN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  });

  /** One record per owner class: alive here, provably gone, unprovable, unowned. */
  async function seed() {
    ids = {
      liveRun: randomUUID(), deadRun: randomUUID(), debtRun: randomUUID(), boundedRun: randomUUID(),
      liveIssue: randomUUID(), stalledIssue: randomUUID(),
      orphanLease: randomUUID(), unownedCleanup: randomUUID(), foreignIntent: randomUUID(), wake: randomUUID(),
      heldWake: randomUUID(),
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
      // Holds admission: a succeeded run with no observed cost.
      { id: ids.debtRun, companyId, agentId, status: "succeeded", invocationSource: "manual", finishedAt: minutesAgo(20),
        costAccountingPending: true },
      // Does not hold admission: its observed cost already counts as exposure.
      { id: ids.boundedRun, companyId, agentId, status: "succeeded", invocationSource: "manual", finishedAt: minutesAgo(20),
        costAccountingPending: true, usageJson: { budgetExposure: { costCents: 12 } } },
    ]);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      windowKind: "calendar_month_utc", amount: 1000 });
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
    // A work intent refused for another run's unfinished accounting (the gate
    // Phase 3 removed). Saved, not dropped, so it is not an I4 violation.
    await db.insert(agentWakeupRequests).values({ id: ids.heldWake, companyId, agentId, source: "automation",
      status: "deferred_issue_execution", payload: { executionWait: { reason: "budget.blocked",
        message: "Company cannot start work while completed runs await accounting." } } });
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

  it("registers every section-C kind once; only kinds moved in Phase 2 settle", () => {
    const names = OWNABLE_KINDS.map(kind => kind.id);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(OWNABLE_KINDS.filter(kind => kind.settle !== null).map(kind => kind.id))
      .toEqual(["native_accepted_result_lease", "native_finalizer_lease", "native_cleanup_lease", "environment_run_lease_active",
        "wake_request_claimed", "legacy_controller_lease"]);
    expect(OWNABLE_KINDS.filter(kind => !kind.listInProgress).every(kind => kind.coverageGap)).toBe(true);
  });

  it("classifies each owner and reports invariant violations without changing any record", async () => {
    await seed();
    const before = await snapshot();
    const state = createOwnershipReportState();

    const first = await runOwnershipReconciliationPass(db, { state, settle: false });

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
    expect(kindReport(first, "run_accounting_debt")).toMatchObject({ inProgress: 2 });

    expect(rules(first, "environment_pending_cleanup")).toEqual(["I1_owned"]);
    // I2 needs the owner proven gone on two consecutive passes.
    expect(rules(first, "environment_run_lease_active")).toEqual([]);
    // Phase 3: pending accounting is exposure, not a gate. Only a refusal that
    // names an accounting hold is an I3 violation.
    expect(first.violations.filter(violation => violation.rule === "I3_admission_independent")
      .map(violation => violation.recordId)).toEqual([ids.heldWake]);
    expect(rules(first, "wake_request")).toEqual(["I3_admission_independent", "I4_exactly_once_intent"]);
    expect(first.violations.filter(violation => violation.rule === "I7_visible_next_action")
      .map(violation => violation.recordId)).toEqual([ids.stalledIssue]);
    expect(Object.keys(first.coverageGaps)).toEqual(["I5_work_based_budgets", "I6_generation_fencing", "I8_fast_turns",
      "I7_scope", "record_cap", "wake_coverage"]);

    expect(first.awaitingSecondProof).toBe(1);
    const second = await runOwnershipReconciliationPass(db, { state, settle: false });
    expect(rules(second, "environment_run_lease_active")).toEqual(["I2_settled"]);
    expect(second.newViolations.map(violation => `${violation.rule}:${violation.kind}`)).toEqual(["I2_settled:environment_run_lease_active"]);

    // A stuck record already reported for I2 needs no further pass.
    expect(second.awaitingSecondProof).toBe(0);
    expect((await runOwnershipReconciliationPass(db, { state, settle: false })).awaitingSecondProof).toBe(0);

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

  it("proves a foreign-boot coordinator gone when its PID-space stamp matches and its PID is dead", async () => {
    const issueId = randomUUID(); const runId = randomUUID(); const legacyRunId = randomUUID(); const legacyIssueId = randomUUID();
    await db.insert(issues).values([{ id: issueId, companyId, title: "Dead owner" }, { id: legacyIssueId, companyId, title: "Legacy" }]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, issueId, status: "running", invocationSource: "manual", runtimeMode: "native", nativeIssueId: issueId },
      { id: legacyRunId, companyId, agentId, issueId: legacyIssueId, status: "running", invocationSource: "manual",
        runtimeMode: "native", nativeIssueId: legacyIssueId },
    ]);
    const claim = { companyId, phase: "observed", leaseOwner: "previous-boot:1:token",
      leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: "previous-boot", controllerPid: 4_194_303,
      controllerProcessStartedAt: new Date("2026-11-07T09:00:00.000Z"), controllerGeneration: 1 };
    await db.insert(nativeRunFinalizations).values([
      { ...claim, runId, issueId, controllerHostHash: currentProcessSpaceHash() },
      // Written before the PID space was stamped: the one-release local proof
      // on a single-host server (#19883), never on an ephemeral one.
      { ...claim, runId: legacyRunId, issueId: legacyIssueId, controllerHostHash: null },
    ]);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(kindReport(report, "native_executor_claim")).toMatchObject({ inProgress: 2,
      verdicts: { gone: 2, unprovable: 0 }, reasons: { pid_dead: 2 } });
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    try {
      const ephemeral = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
      expect(kindReport(ephemeral, "native_executor_claim")).toMatchObject({ inProgress: 2,
        verdicts: { gone: 1, unprovable: 1 }, reasons: { pid_dead: 1, process_space_unrecorded: 1 } });
    } finally { vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", ""); }
  });

  it("settles a claimed wake whose run finished without settling it, and only that one", async () => {
    // K4 wave (2026-11-07): native restart recovery blocked a run and ended it
    // without settling its assignment wake, which stayed `claimed` for good.
    const issueIds = { blocked: randomUUID(), pending: randomUUID(), unprojected: randomUUID(), applied: randomUUID() };
    await db.insert(issues).values(Object.entries(issueIds).map(([title, id]) => ({ id, companyId, title })));
    const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, companyId, agentId, status,
      invocationSource: "manual", ...(status === "running" ? {} : { finishedAt: minutesAgo(2) }), ...extra });
    const native = (issueId: string, nativePhase: string | null, extra: Record<string, unknown> = {}) =>
      ({ runtimeMode: "native", nativeIssueId: issueId, issueId, nativePhase, ...extra });
    const runs = { blocked: randomUUID(), pending: randomUUID(), unprojected: randomUUID(), applied: randomUUID(),
      legacyDone: randomUUID(), interrupted: randomUUID(), live: randomUUID() };
    await db.insert(heartbeatRuns).values([
      run(runs.blocked, "failed", native(issueIds.blocked, "terminal_failure", { error: "execution_recovery_budget_exhausted",
        errorCode: "native_restart_recovery_blocked" })),
      // The coordinator is not final yet.
      run(runs.pending, "failed", native(issueIds.pending, "observed")),
      // Final coordinator, run row not yet projected (its phase lags):
      // projection may still change the run's outcome.
      run(runs.unprojected, "failed", native(issueIds.unprojected, "workspace_finalizing")),
      run(runs.applied, "succeeded", native(issueIds.applied, null)),
      run(runs.legacyDone, "succeeded"),
      run(runs.interrupted, "interrupted"),
      run(runs.live, "running"),
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId: runs.blocked, companyId, issueId: issueIds.blocked, phase: "terminal_failure", failureCode: "native_restart_recovery_blocked" },
      { runId: runs.pending, companyId, issueId: issueIds.pending, phase: "observed" },
      { runId: runs.applied, companyId, issueId: issueIds.applied, phase: "applied" },
    ]);
    await db.insert(nativeRunFinalizations).values({ runId: runs.unprojected, companyId, issueId: issueIds.unprojected,
      phase: "terminal_failure", failureCode: "fixture" });
    const wakes = Object.fromEntries(Object.entries(runs).map(([name, runId]) => [name, { id: randomUUID(), runId }]));
    await db.insert(agentWakeupRequests).values(Object.values(wakes).map(wake => ({ id: wake.id, companyId, agentId,
      source: "assignment", status: "claimed", runId: wake.runId, claimedAt: minutesAgo(5) })));
    const statusOf = async () => Object.fromEntries((await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)).map(row => [Object.keys(wakes).find(name => wakes[name].id === row.id), row.status]));
    const allClaimed = Object.fromEntries(Object.keys(wakes).map(name => [name, "claimed"]));

    // A read-only pass never settles.
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(await statusOf()).toEqual(allClaimed);

    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state });
    expect(kindReport(first, "wake_request_claimed")).toMatchObject({ inProgress: 7, settled: 4 });
    expect(await statusOf()).toEqual({ blocked: "failed", pending: "claimed", unprojected: "claimed", applied: "completed",
      legacyDone: "completed", interrupted: "cancelled", live: "claimed" });
    const [blocked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakes.blocked.id));
    expect(blocked).toMatchObject({ error: "execution_recovery_budget_exhausted" });
    expect(blocked.finishedAt).not.toBeNull();
    // Settled claims are no longer in progress. The two waiting on projection
    // are not settled, and rule I2 names them if projection never comes.
    const second = await runOwnershipReconciliationPass(db, { state });
    expect(second.violations.filter(violation => violation.kind === "wake_request_claimed").map(violation => violation.recordId).sort())
      .toEqual([wakes.pending.id, wakes.unprojected.id].sort());
  });

  it("writes nothing when recording is off", async () => {
    await seed();
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.length).toBeGreaterThan(0);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("never reports pending accounting itself as an admission violation", async () => {
    await seed();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, ids.heldWake));
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(kindReport(report, "run_accounting_debt")).toMatchObject({ inProgress: 2 });
    expect(report.violations.filter(violation => violation.rule === "I3_admission_independent")).toEqual([]);
  });

  it("reads every temporary refusal in a busy window, past unrelated failures", async () => {
    const state = createOwnershipReportState();
    await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    await db.insert(agentWakeupRequests).values(Array.from({ length: 5 }, () => ({ companyId, agentId,
      source: "assignment", status: "failed", error: "adapter exited with code 1" })));
    const refused = Array.from({ length: 5 }, () => randomUUID());
    await db.insert(agentWakeupRequests).values(refused.map(id => ({ id, companyId, agentId, source: "assignment",
      status: "skipped", error: "issue lock busy" })));
    const report = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(report.violations.filter(violation => violation.rule === "I4_exactly_once_intent")
      .map(violation => violation.recordId).sort()).toEqual([...refused].sort());
    const again = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(again.violations.filter(violation => violation.rule === "I4_exactly_once_intent")).toEqual([]);
  });

  it("attributes spool files to their company", async () => {
    await mkdir(orphanSpool, { recursive: true });
    const runId = randomUUID();
    await writeFile(join(orphanSpool, "orphan-1.json"), JSON.stringify({ companyId, heartbeatRunId: runId }));
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(report.violations.filter(violation => violation.kind === "sandbox_orphan_cleanup_spool")).toEqual([
      expect.objectContaining({ rule: "I1_owned", recordId: "orphan-1", companyId, runId }),
    ]);
    expect(await db.select({ entityId: activityLog.entityId }).from(activityLog)
      .where(eq(activityLog.action, OWNERSHIP_INVARIANT_VIOLATION_ACTION))).toEqual([{ entityId: "orphan-1" }]);
  });

  it("reports a run cancelled for an accounting hold", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", invocationSource: "manual",
      error: "New work must wait while a native run recovers its unfinished accounting." });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.rule === "I3_admission_independent")).toEqual([
      expect.objectContaining({ kind: "queued_run", recordId: runId, reason: "refused_for_accounting_hold" })]);
  });

  it("reads every accounting-hold refusal in a busy window across passes", async () => {
    const state = createOwnershipReportState();
    await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    const refused = Array.from({ length: 25 }, () => randomUUID());
    await db.insert(agentWakeupRequests).values(refused.map(id => ({ id, companyId, agentId, source: "assignment",
      status: "skipped", error: "Company cannot start work while completed runs await accounting." })));
    const seen: string[] = [];
    const first = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    // Ten pages of two: the rest waits for the next pass, which is kept due.
    expect(first.retryNeeded).toBe(true);
    seen.push(...first.violations.filter(violation => violation.rule === "I3_admission_independent").map(violation => violation.recordId));
    const second = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    seen.push(...second.violations.filter(violation => violation.rule === "I3_admission_independent").map(violation => violation.recordId));
    expect(seen.sort()).toEqual([...refused].sort());
    const third = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(third.violations.filter(violation => violation.rule === "I3_admission_independent")).toEqual([]);
  });

  it("treats a saved monitor deadline as a next action", async () => {
    await db.insert(issues).values({ companyId, title: "Monitored", status: "in_progress", assigneeAgentId: agentId,
      updatedAt: minutesAgo(30), monitorNextCheckAt: new Date(Date.now() + 60 * 60_000) });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.rule === "I7_visible_next_action")).toEqual([]);
  });

  it("returns the end of the next-action grace window for an issue still inside it", async () => {
    const updatedAt = minutesAgo(2);
    await db.insert(issues).values({ companyId, title: "Fresh", status: "in_progress", assigneeAgentId: agentId, updatedAt });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.rule === "I7_visible_next_action")).toEqual([]);
    expect(report.nextDueAt?.getTime()).toBe(updatedAt.getTime() + 5 * 60_000);
  });

  it("retries a violation whose activity row failed to save", async () => {
    await mkdir(orphanSpool, { recursive: true });
    const laterCompany = randomUUID();
    await writeFile(join(orphanSpool, "orphan-2.json"), JSON.stringify({ companyId: laterCompany }));
    const state = createOwnershipReportState();
    // The company does not exist yet, so the activity insert fails its foreign key.
    const first = await runOwnershipReconciliationPass(db, { state });
    expect(first.retryNeeded).toBe(true);
    expect(await db.select().from(activityLog)).toEqual([]);

    await db.insert(companies).values({ id: laterCompany, name: "Later", issuePrefix: "LAT" });
    await rm(orphanSpool, { recursive: true, force: true });
    const second = await runOwnershipReconciliationPass(db, { state });
    expect(second.retryNeeded).toBe(false);
    expect(await db.select({ entityId: activityLog.entityId, companyId: activityLog.companyId }).from(activityLog))
      .toEqual([{ entityId: "orphan-2", companyId: laterCompany }]);
  });

  it("drops a violation whose activity row keeps failing after five attempts", async () => {
    await mkdir(orphanSpool, { recursive: true });
    await writeFile(join(orphanSpool, "orphan-3.json"), JSON.stringify({ companyId: randomUUID() }));
    const state = createOwnershipReportState();
    const passes: boolean[] = [];
    for (let pass = 0; pass < 6; pass++) passes.push((await runOwnershipReconciliationPass(db, { state })).retryNeeded);
    expect(passes).toEqual([true, true, true, true, false, false]);
  });

  it("reads a kind larger than one page in a single pass, so second proofs compare the same records", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", invocationSource: "manual" });
    const leases = [randomUUID(), randomUUID(), randomUUID()].sort();
    await db.insert(environmentLeases).values(leases.map(id => ({ id, companyId, heartbeatRunId: runId, status: "active" })));
    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(kindReport(first, "environment_run_lease_active")).toMatchObject({ inProgress: 3, truncated: false, verdicts: { gone: 3 } });
    expect(first.awaitingSecondProof).toBe(3);
    const second = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(second.violations.filter(violation => violation.rule === "I2_settled").map(violation => violation.recordId).sort())
      .toEqual(leases);
    expect(second.awaitingSecondProof).toBe(0);
    expect(second.retryNeeded).toBe(false);
  });

  it("keeps a wake that lands while dispatch is drained", async () => {
    let allowed = false;
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const reports: OwnershipReport[] = [];
    const worker = registerOwnershipReconciliationWork(db, coordinator, () => allowed, { onReport: report => reports.push(report) });
    try {
      await worker.ready;
      expect(reports).toHaveLength(0);
      // The skipped startup pass is still pending, so a retry stays due.
      expect(coordinator.nextWakeAt()).not.toBeNull();
      allowed = true;
      worker.wake();
      await expect.poll(() => reports.length, { timeout: 60_000, interval: 100 }).toBe(1);
    } finally {
      await coordinator.stop();
    }
  }, 90_000);

  it("keeps re-proving a settling kind's live owner, which can die without a signal", async () => {
    const settle = vi.fn(async () => ({ settled: true, reason: "pid_dead" }));
    const liveOwner = { kind: "process" as const, stamp: { kind: "local" as const, scope: "fixture", generation: null, host: null,
      processSpace: currentProcessSpaceHash(), bootId: currentControllerBootId(), pid: process.pid, processStartedAt: null } };
    const fixture = { ...OWNABLE_KINDS.find(kind => kind.id === "native_accepted_result_lease")!, id: "fixture_settling_kind",
      settle, listInProgress: async () => ({ truncated: false, records: [{ recordId: "r1", companyId, runId: null, issueId: null,
        owner: liveOwner, updatedAt: null }] }) };
    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state, kinds: [fixture] });
    const second = await runOwnershipReconciliationPass(db, { state, kinds: [fixture] });
    // The set is unchanged, so only the settle watch keeps a re-check due.
    expect([first.settleWatch, second.settleWatch]).toEqual([1, 1]);
    expect(settle).not.toHaveBeenCalled();
    const reportOnly = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
      kinds: [{ ...fixture, settle: null }] });
    expect(reportOnly.settleWatch).toBe(0);
    // The watch's re-check lists only settling kinds; a report-only kind's
    // listing is never read.
    const reportOnlyList = vi.fn(async () => ({ truncated: false, records: [] }));
    const recheck = await recheckSettlingKinds(db, { kinds: [fixture, { ...fixture, id: "fixture_report_only", settle: null,
      listInProgress: reportOnlyList }] });
    expect(recheck).toEqual({ settled: [], watched: 1 });
    expect(reportOnlyList).not.toHaveBeenCalled();
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
      await coordinator.stop();
    }
  }, 90_000);
});
