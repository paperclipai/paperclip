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
  completionContracts,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  sandboxCreationOperations,
  statusDecisions,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { currentControllerBootId, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { applyOwnershipReportBackstops, registerOwnershipReconciliationWork } from "../services/native-runtime/native-finalization-reconciler.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { listUndispatchedQueuedRuns, readUndispatchedQueuedRuns, undispatchedQueuedRunPageQuery } from "../services/queued-run-dispatch-liveness.js";
import { releaseLapsedCoordinatorOwner } from "../services/workspace-recovery-stop-proof.js";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import {
  createOwnershipReportState,
  OWNERSHIP_INVARIANT_VIOLATION_ACTION,
  recheckSettlingKinds,
  runOwnershipReconciliationPass,
  type OwnershipReport,
} from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { trackRemoteWorkspaceSaveInvocationForTests } from "../services/remote-workspaces.js";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { preparedRemoteWorkspaceSource } from "../services/remote-workspace-lifecycle.js";
import { readRemoteWorkspaceWriterHold } from "../services/remote-workspace-writer-hold.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

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
    await db.execute(sql`truncate budget_policies, activity_log, workspace_operations, agent_wakeup_requests, sandbox_creation_operations, environment_leases,
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
      status: "skipped", reason: "agent.not_invokable", requestedByActorType: "user", error: "Agent is paused" });
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
      .toEqual(["native_executor_claim", "native_restart_recovery_claim", "native_awaiting_evidence", "native_accepted_result_lease", "native_finalizer_lease", "native_cleanup_lease", "sandbox_creation_intent", "environment_run_lease_active", "environment_teardown_claim", "environment_retained_orphan_sandbox", "environment_login_probe_lease", "workspace_runtime_control_operation", "native_workspace_finalize_attempt", "workspace_command_operation", "remote_snapshot_save", "execution_workspace_runtime_lease", "remote_workspace_unsaved_files", "remote_snapshot_ledger", "legacy_shutdown_settlement_fence", "copyback_owner_hold", "observed_workspace_preservation_fence", "wake_request_claimed", "legacy_controller_lease", "legacy_interrupted_preparation_hold", "native_completed_turn_cleanup_hold", "issue_execution_lock", "issue_checkout_lock", "agent_lifecycle_lease"]);
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
    // The cleanup queue owns an unclaimed item while its retry deadline is current.
    expect(kindReport(first, "environment_pending_cleanup")).toMatchObject({ inProgress: 1,
      verdicts: { alive: 1 }, reasons: { queue_scheduled: 1 } });
    // A different PID space is never proof.
    expect(currentProcessSpaceHash()).not.toBe("another-pid-space");
    expect(kindReport(first, "sandbox_creation_intent")).toMatchObject({ inProgress: 1,
      verdicts: { unprovable: 1 }, reasons: { different_process_space: 1 } });
    expect(kindReport(first, "run_accounting_debt")).toMatchObject({ inProgress: 2 });

    expect(rules(first, "environment_pending_cleanup")).toEqual([]);
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

  it("proves a recorded same-space Native controller gone while keeping a legacy NULL controller unprovable", async () => {
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
      { ...claim, runId: legacyRunId, issueId: legacyIssueId, controllerHostHash: null },
    ]);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(kindReport(report, "native_executor_claim")).toMatchObject({ inProgress: 2,
      verdicts: { gone: 1, unprovable: 1 }, reasons: { pid_dead: 1, process_space_unrecorded: 1 } });
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

  // Non-wake recovery (Phase 3): a task lock is owned by the run it names. A
  // restart between the run's terminal write and the lock release left the
  // task locked to a dead run until the next periodic sweep. The reconciler
  // now settles it on the proof (the run's terminal row), never by age.
  it("settles a task lock whose run ended without releasing it, and keeps live or resuming ones", async () => {
    const ids = { dead: randomUUID(), live: randomUUID(), resuming: randomUUID() };
    const runs = { dead: randomUUID(), live: randomUUID(), resuming: randomUUID() };
    await db.insert(heartbeatRuns).values([
      { id: runs.dead, companyId, agentId, status: "failed", invocationSource: "manual", finishedAt: minutesAgo(1) },
      { id: runs.live, companyId, agentId, status: "running", invocationSource: "manual" },
      { id: runs.resuming, companyId, agentId, status: "failed", invocationSource: "manual", finishedAt: minutesAgo(1),
        runtimeMode: "native", nativeIssueId: ids.resuming },
    ]);
    await db.insert(issues).values(Object.entries(ids).map(([name, id]) => ({ id, companyId, title: name, status: "in_progress",
      assigneeAgentId: agentId, executionRunId: runs[name as keyof typeof runs], checkoutRunId: runs[name as keyof typeof runs],
      executionLockedAt: minutesAgo(1) })));
    // A same-run resume still needs the failed run's lock.
    await db.insert(nativeRunFinalizations).values({ runId: runs.resuming, companyId, issueId: ids.resuming, phase: "retryable_failure" });
    const locks = async () => Object.fromEntries((await db.select({ id: issues.id, executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId }).from(issues)).map(row =>
      [Object.keys(ids).find(name => ids[name as keyof typeof ids] === row.id), row.executionRunId === null && row.checkoutRunId === null]));
    const allHeld = { dead: false, live: false, resuming: false };

    // A read-only pass never settles.
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(await locks()).toEqual(allHeld);

    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(await locks()).toEqual({ dead: true, live: false, resuming: false });
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, ids.dead)))
      .toContainEqual({ action: "issue.stale_lock_cleared" });
  });

  it("settles a finalize attempt whose process died mid-copyback, and keeps live or independent ones", async () => {
    // Crash points workspace.finalize.after_start_before_copyback and
    // .after_copyback_before_done: the run finished through a later attempt,
    // but the interrupted attempt stayed `running`.
    const run = (id: string, status: string) => ({ id, companyId, agentId, status, invocationSource: "manual",
      ...(status === "running" ? {} : { finishedAt: minutesAgo(2) }) });
    const runs = { done: randomUUID(), live: randomUUID(), legacyDone: randomUUID(), legacyLive: randomUUID() };
    await db.insert(heartbeatRuns).values([run(runs.done, "succeeded"), run(runs.live, "running"),
      run(runs.legacyDone, "succeeded"), run(runs.legacyLive, "running")]);
    const dead = { bootId: "previous-boot", pid: 4_194_303, hostHash: currentProcessSpaceHash(),
      processStartedAt: "2026-11-07T09:00:00.000Z" };
    const ops = { dead: randomUUID(), live: randomUUID(), foreign: randomUUID(), uncertain: randomUUID(),
      legacyDone: randomUUID(), legacyLive: randomUUID() };
    const op = (id: string, runId: string, metadata: Record<string, unknown>) => ({ id, companyId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "running", metadata });
    await db.insert(workspaceOperations).values([
      op(ops.dead, runs.done, { finalizeOwner: dead }),
      // Stamped by this process and still running here (current boot): alive.
      op(ops.live, runs.live, { finalizeOwner: { bootId: currentControllerBootId(), pid: process.pid,
        hostHash: currentProcessSpaceHash(), processStartedAt: null } }),
      // Another PID space is never proof.
      op(ops.foreign, runs.done, { finalizeOwner: { ...dead, hostHash: "another-pid-space" } }),
      op(ops.uncertain, runs.done, { finalizeOwner: dead, uncertain: true }),
      // Written before the stamp: owned by its run.
      op(ops.legacyDone, runs.legacyDone, {}),
      op(ops.legacyLive, runs.legacyLive, {}),
    ]);
    const statuses = async () => Object.fromEntries((await db.select({ id: workspaceOperations.id, status: workspaceOperations.status })
      .from(workspaceOperations)).map(row => [Object.keys(ops).find(name => ops[name as keyof typeof ops] === row.id), row.status]));

    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(Object.values(await statuses()).every(status => status === "running")).toBe(true);

    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state });
    expect(kindReport(first, "native_workspace_finalize_attempt")).toMatchObject({ inProgress: 6, settled: 2 });
    expect(await statuses()).toEqual({ dead: "failed", live: "running", foreign: "running", uncertain: "running",
      legacyDone: "failed", legacyLive: "running" });
    const [settled] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ops.dead));
    expect(settled.metadata).toMatchObject({ abandonedFinalization: { reason: "abandoned_workspace_finalization", proof: "pid_dead" } });
    expect(settled.finishedAt).not.toBeNull();
    // The run's outcome never changes.
    const [doneRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs.done));
    expect(doneRun.status).toBe("succeeded");
  });

  it("settles a remote snapshot save that stopped without finishing after its run ended, and keeps open or live ones", async () => {
    const run = (id: string, status: string) => ({ id, companyId, agentId, status, invocationSource: "manual",
      ...(status === "running" ? {} : { finishedAt: minutesAgo(2) }) });
    const runs = { failed: randomUUID(), live: randomUUID() };
    await db.insert(heartbeatRuns).values([run(runs.failed, "failed"), run(runs.live, "running")]);
    const quiesced = { schema: "paperclip.remote-workspace-save-work.v1", activeIds: [], unknown: false, quiescedAt: minutesAgo(30).toISOString() };
    const liveInvocation = randomUUID();
    const ops = { abandoned: randomUUID(), pendingAbandoned: randomUUID(), liveRun: randomUUID(), activeInvocation: randomUUID(),
      unknownWork: randomUUID(), notQuiesced: randomUUID(), invalidWork: randomUUID() };
    const op = (id: string, runId: string, saveWork: Record<string, unknown>, status = "running") => ({ id, companyId, heartbeatRunId: runId,
      phase: "remote_workspace_snapshot", status,
      metadata: { epoch: 8, boundary: "final", generation: 9, saveWork, exportCleanup: { state: "pending" } } });
    await db.insert(workspaceOperations).values([
      op(ops.abandoned, runs.failed, quiesced),
      op(ops.pendingAbandoned, runs.failed, quiesced, "pending"),
      op(ops.liveRun, runs.live, quiesced),
      op(ops.activeInvocation, runs.failed, { ...quiesced, activeIds: [liveInvocation], quiescedAt: null,
        owners: { [liveInvocation]: { bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null } } }),
      op(ops.unknownWork, runs.failed, { ...quiesced, unknown: true }),
      op(ops.notQuiesced, runs.failed, { ...quiesced, quiescedAt: null }),
      op(ops.invalidWork, runs.failed, { ...quiesced, quiescedAt: "" }),
    ]);
    const statuses = async () => Object.fromEntries((await db.select({ id: workspaceOperations.id, status: workspaceOperations.status })
      .from(workspaceOperations).where(eq(workspaceOperations.phase, "remote_workspace_snapshot")))
      .map(row => [Object.keys(ops).find(name => ops[name as keyof typeof ops] === row.id), row.status]));

    const untrack = trackRemoteWorkspaceSaveInvocationForTests(liveInvocation);
    const first = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() }).finally(untrack);
    expect(kindReport(first, "remote_snapshot_save")).toMatchObject({ inProgress: 7, settled: 2 });
    expect(await statuses()).toEqual({ abandoned: "failed", pendingAbandoned: "failed", liveRun: "running", activeInvocation: "running",
      unknownWork: "running", notQuiesced: "running", invalidWork: "running" });
    const [settled] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ops.abandoned));
    expect(settled.metadata).toMatchObject({ saveWork: quiesced, exportCleanup: { state: "pending" },
      abandonedSave: { reason: "abandoned_remote_snapshot_save", runId: runs.failed, previousStatus: "running" },
      lastFailure: { code: "remote_workspace_save_abandoned" } });
    expect(settled.finishedAt).not.toBeNull();
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs.failed));
    expect(failedRun.status).toBe("failed");
  });

  it("settles a remote snapshot save whose process died mid-save, and keeps live, foreign or unprovable ones", async () => {
    const run = (id: string, status: string) => ({ id, companyId, agentId, status, invocationSource: "manual",
      ...(status === "running" ? {} : { finishedAt: minutesAgo(2), errorCode: "process_lost" }) });
    const runs = { lost: randomUUID(), live: randomUUID() };
    await db.insert(heartbeatRuns).values([run(runs.lost, "failed"), run(runs.live, "running")]);
    const dead = { bootId: "previous-boot", pid: 4_194_303, hostHash: currentProcessSpaceHash(),
      processStartedAt: "2026-11-07T09:00:00.000Z" };
    const self = { bootId: currentControllerBootId(), pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null };
    const ops = { deadOwner: randomUUID(), selfOwner: randomUUID(), foreignOwner: randomUUID(), legacyLost: randomUUID(),
      legacyLive: randomUUID(), mixed: randomUUID() };
    const op = (id: string, runId: string, owners: Record<string, unknown> | undefined, activeIds = [randomUUID()]) => ({
      id, companyId, heartbeatRunId: runId, phase: "remote_workspace_snapshot", status: "running",
      metadata: { epoch: 1, boundary: "initial", generation: 1, exportCleanup: { state: "pending" },
        saveWork: { schema: "paperclip.remote-workspace-save-work.v1", activeIds, unknown: false, quiescedAt: null,
          ...(owners ? { owners: Object.fromEntries(activeIds.map((invocation, index) => [invocation, Object.values(owners)[index]])
            .filter(([, stamp]) => stamp !== undefined)) } : {}) } } });
    const twoIds = [randomUUID(), randomUUID()], selfInvocation = randomUUID();
    await db.insert(workspaceOperations).values([
      op(ops.deadOwner, runs.live, { a: dead }),
      op(ops.selfOwner, runs.lost, { a: self }, [selfInvocation]),
      op(ops.foreignOwner, runs.lost, { a: { ...dead, hostHash: "another-pid-space" } }),
      op(ops.legacyLost, runs.lost, undefined),
      op(ops.legacyLive, runs.live, undefined),
      op(ops.mixed, runs.lost, { a: dead }, twoIds),
    ]);
    const statuses = async () => Object.fromEntries((await db.select({ id: workspaceOperations.id, status: workspaceOperations.status })
      .from(workspaceOperations).where(eq(workspaceOperations.phase, "remote_workspace_snapshot")))
      .map(row => [Object.keys(ops).find(name => ops[name as keyof typeof ops] === row.id), row.status]));

    const untrack = trackRemoteWorkspaceSaveInvocationForTests(selfInvocation);
    const first = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() }).finally(untrack);
    expect(kindReport(first, "remote_snapshot_save")).toMatchObject({ inProgress: 6, settled: 2 });
    expect(await statuses()).toEqual({ deadOwner: "failed", selfOwner: "running", foreignOwner: "running",
      legacyLost: "failed", legacyLive: "running", mixed: "running" });
    const [settled] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ops.deadOwner));
    expect(settled.metadata).toMatchObject({ saveWork: { activeIds: [], owners: {}, unknown: false, quiescedAt: expect.any(String) },
      abandonedSave: { reason: "abandoned_remote_snapshot_save", proof: "pid_dead", abandonedInvocationIds: [expect.any(String)] },
      lastFailure: { code: "remote_workspace_save_abandoned" } });
    const [liveRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs.live));
    expect(liveRun.status).toBe("running");
  });

  it("ends a dirty remote epoch whose writer died during preparation, and keeps every other writer's files", async () => {
    const runs = { preparing: randomUUID(), resolved: randomUUID(), executing: randomUUID(), live: randomUUID(), saving: randomUUID(),
      invoked: randomUUID(), spawned: randomUUID() };
    const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, companyId, agentId, status,
      invocationSource: "manual", executionStage: "preparing", ...(status === "running" ? {} : { finishedAt: minutesAgo(2), errorCode: "process_lost" }), ...extra });
    await db.insert(heartbeatRuns).values([
      run(runs.preparing, "failed"),
      run(runs.resolved, "failed", { runtimeMode: "native", runtimeModeResolvedAt: minutesAgo(3) }),
      run(runs.executing, "failed", { executionStage: "executing" }),
      run(runs.live, "running"),
      run(runs.saving, "failed"),
      run(runs.invoked, "failed"),
      run(runs.spawned, "failed", { processPid: 4_194_303 }),
    ]);
    await db.insert(heartbeatRunEvents).values({ companyId, runId: runs.invoked, agentId, seq: 1, eventType: "adapter.invoke" });
    const workspaceFor = Object.fromEntries(Object.keys(runs).map(name => [name, randomUUID()])) as Record<keyof typeof runs, string>;
    await db.insert(executionWorkspaces).values(Object.entries(runs).map(([name, writerRunId]) => ({
      id: workspaceFor[name as keyof typeof runs], companyId, mode: "isolated_workspace", strategyType: "test", name,
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null,
        source: { kind: "git", repoUrl: "https://example.invalid/repo.git", ref: null }, dirty: true, writerRunId,
        location: { environmentId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "sandbox-1", remoteCwd: "/workspace/root" } } },
    })));
    await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: workspaceFor.saving, heartbeatRunId: runs.saving,
      phase: "remote_workspace_snapshot", status: "running", metadata: { epoch: 1, boundary: "initial" } });
    const authorities = async () => Object.fromEntries((await db.select().from(executionWorkspaces))
      .filter(row => Object.values(workspaceFor).includes(row.id))
      .map(row => [row.name, readRemoteWorkspaceAuthority(row.metadata)]));

    const first = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(kindReport(first, "remote_workspace_unsaved_files")).toMatchObject({ settled: 1 });
    const after = await authorities();
    expect(after.preparing).toMatchObject({ epoch: 2, dirty: false, writerRunId: null, location: null, snapshotId: null });
    for (const kept of ["resolved", "executing", "live", "saving", "invoked", "spawned"] as const)
      expect(after[kept], kept).toMatchObject({ epoch: 1, dirty: true, writerRunId: runs[kept] });
    const unsavedFiles = OWNABLE_KINDS.find(kind => kind.id === "remote_workspace_unsaved_files")!;
    expect((await recheckSettlingKinds(db, { kinds: [unsavedFiles] })).watched).toBe(2);
    const [abandoned] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceFor.preparing));
    expect(abandoned.metadata?.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 1, runId: runs.preparing })]);
  });

  it("releases the lease and frees the workspace for the retry once a preparation-only epoch ends", async () => {
    const runId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), leaseId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Remote task", status: "in_progress" });
    const [environment] = await db.insert(environments).values({ name: `Sandbox ${randomUUID()}`, driver: "sandbox" }).returning();
    const location = { environmentId: environment.id, leaseId, providerLeaseId: `sandbox-${randomUUID()}`, remoteCwd: "/workspace/task" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", invocationSource: "manual",
      executionStage: "preparing", finishedAt: minutesAgo(2), errorCode: "process_lost", contextSnapshot: { issueId },
      runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId,
        providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd, epoch: 1, state: "prepared", snapshotId: null } } });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "test", name: "Remote task workspace",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null,
        source: { kind: "git", repoUrl: "https://example.invalid/repo.git", ref: null }, dirty: true, writerRunId: runId, location } } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment.id, issueId,
      heartbeatRunId: runId, executionWorkspaceId: workspaceId, status: "active", leasePolicy: "ephemeral", provider: "daytona",
      providerLeaseId: location.providerLeaseId, metadata: { remoteCwd: location.remoteCwd } }).returning();
    const authority = async () => readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId)))[0]!.metadata)!;
    expect(await preparedRemoteWorkspaceSource(db, lease)).not.toBeNull();
    expect(await readRemoteWorkspaceWriterHold(db, { companyId, authority: await authority(), runId: randomUUID() }))
      .toMatchObject({ kind: "held" });

    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(await preparedRemoteWorkspaceSource(db, lease)).toBeNull();
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!.status).not.toBe("active");
    expect(await readRemoteWorkspaceWriterHold(db, { companyId, authority: await authority(), runId: randomUUID() }))
      .toEqual({ kind: "free" });
  });

  it("hands on a preparation-only epoch at its saved version only when the unchanged baseline is proven", async () => {
    // Each writer restored saved version `snapshotId` and was killed in
    // preparation. Only `clean` has nothing after the restore; every other
    // writer lacks the proof and keeps today's abandonment.
    const cases = ["clean", "noBaseline", "otherEpochBaseline", "releasedBaseline", "provisioned", "processStarted"] as const;
    const snapshotId = randomUUID();
    const setup = Object.fromEntries(cases.map(name => [name, {
      runId: randomUUID(), workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: `sandbox-${randomUUID()}`,
    }])) as Record<(typeof cases)[number], { runId: string; workspaceId: string; leaseId: string; providerLeaseId: string }>;
    const remoteCwd = (name: string) => `/home/daytona/paperclip-workspace/.paperclip-workspaces/${setup[name as keyof typeof setup].workspaceId}`;
    await db.insert(heartbeatRuns).values(cases.map(name => {
      const s = setup[name];
      return { id: s.runId, companyId, agentId, status: "failed", invocationSource: "manual", executionStage: "preparing",
        finishedAt: minutesAgo(2), errorCode: "process_lost",
        ...(name === "processStarted" ? { processPid: 4_194_303 } : {}),
        runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId: s.workspaceId,
          leaseId: s.leaseId, providerLeaseId: s.providerLeaseId, remoteCwd: remoteCwd(name), epoch: 2, state: "prepared", snapshotId } } };
    }));
    await db.insert(executionWorkspaces).values(cases.map(name => {
      const s = setup[name];
      const baseline = name === "noBaseline" ? {}
        : { remoteWorkspaceUnchangedBaseline: { schema: "paperclip.remote-workspace-unchanged-baseline.v1",
          epoch: name === "otherEpochBaseline" ? 1 : 2, runId: s.runId, snapshotId,
          ...(name === "releasedBaseline" ? { releasedAt: minutesAgo(5).toISOString() } : {}) } };
      return { id: s.workspaceId, companyId, mode: "isolated_workspace", strategyType: "test", name,
        metadata: { ...baseline, remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId,
          source: { kind: "git", repoUrl: "https://example.invalid/repo.git", ref: null }, dirty: true, writerRunId: s.runId,
          location: { environmentId: randomUUID(), leaseId: s.leaseId, providerLeaseId: s.providerLeaseId, remoteCwd: remoteCwd(name) } } } };
    }));
    // The restore itself is file-neutral; a provisioning command is not.
    await db.insert(workspaceOperations).values(cases.map(name => ({ companyId, executionWorkspaceId: setup[name].workspaceId,
      heartbeatRunId: setup[name].runId, phase: "remote_workspace_restore", status: "succeeded", metadata: { epoch: 2, snapshotId } })));
    await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: setup.provisioned.workspaceId,
      heartbeatRunId: setup.provisioned.runId, phase: "remote_workspace_provision", status: "failed", metadata: { epoch: 2 } });
    const read = async (name: (typeof cases)[number]) => (await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, setup[name].workspaceId)))[0]!;

    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });

    const clean = await read("clean");
    expect(readRemoteWorkspaceAuthority(clean.metadata)).toMatchObject({ epoch: 2, dirty: false, writerRunId: null, snapshotId,
      location: { leaseId: setup.clean.leaseId, providerLeaseId: setup.clean.providerLeaseId, remoteCwd: remoteCwd("clean") } });
    expect(clean.metadata?.remoteWorkspaceAbandonedEpochs).toBeUndefined();
    expect(clean.metadata?.remoteWorkspaceUnchangedBaseline).toMatchObject({ releasedAt: expect.any(String) });
    const [cleanRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, setup.clean.runId));
    expect(cleanRun.runnerProfileJson?.remoteWorkspace).toMatchObject({ state: "saved", epoch: 2 });
    // The retry is admitted at once, and the killed run's sandbox is no longer a prepared source holding it.
    expect(await readRemoteWorkspaceWriterHold(db, { companyId, authority: readRemoteWorkspaceAuthority(clean.metadata)!,
      runId: randomUUID() })).toEqual({ kind: "free" });
    // A recorded process is runtime work: neither handed on nor abandoned here.
    expect(readRemoteWorkspaceAuthority((await read("processStarted")).metadata))
      .toMatchObject({ epoch: 2, dirty: true, writerRunId: setup.processStarted.runId });
    for (const name of cases.filter(name => name !== "clean" && name !== "processStarted")) {
      const row = await read(name);
      expect(readRemoteWorkspaceAuthority(row.metadata), name)
        .toMatchObject({ epoch: 3, dirty: false, writerRunId: null, location: null });
      expect(row.metadata?.remoteWorkspaceAbandonedEpochs, name).toEqual([expect.objectContaining({ epoch: 2, runId: setup[name].runId })]);
    }
  });

  it("settles a workspace command whose process died mid-command, and keeps live or unprovable ones", async () => {
    const run = (id: string, status: string) => ({ id, companyId, agentId, status, invocationSource: "manual",
      ...(status === "running" ? {} : { finishedAt: minutesAgo(2) }) });
    const runs = { interrupted: randomUUID(), live: randomUUID() };
    await db.insert(heartbeatRuns).values([run(runs.interrupted, "failed"), run(runs.live, "running")]);
    const dead = { bootId: "previous-boot", pid: 4_194_303, hostHash: currentProcessSpaceHash(),
      processStartedAt: "2026-11-09T09:00:00.000Z" };
    const ops = { dead: randomUUID(), live: randomUUID(), foreign: randomUUID(), legacyDone: randomUUID(),
      legacyLive: randomUUID(), unowned: randomUUID(), runtimeControl: randomUUID() };
    const op = (id: string, runId: string | null, phase: string, metadata: Record<string, unknown>) => ({ id, companyId,
      heartbeatRunId: runId, phase, status: "running", metadata });
    await db.insert(workspaceOperations).values([
      op(ops.dead, runs.interrupted, "workspace_provision", { commandOwner: dead }),
      op(ops.live, runs.live, "worktree_prepare", { commandOwner: { bootId: currentControllerBootId(), pid: process.pid,
        hostHash: currentProcessSpaceHash(), processStartedAt: null } }),
      op(ops.foreign, runs.interrupted, "workspace_provision", { commandOwner: { ...dead, hostHash: "another-pid-space" } }),
      op(ops.legacyDone, runs.interrupted, "workspace_teardown", {}),
      op(ops.legacyLive, runs.live, "workspace_provision", {}),
      op(ops.unowned, null, "worktree_cleanup", {}),
      op(ops.runtimeControl, null, "workspace_runtime_provision", { runtimeControlOwner: { pid: 1 } }),
    ]);
    const statuses = async () => Object.fromEntries((await db.select({ id: workspaceOperations.id, status: workspaceOperations.status })
      .from(workspaceOperations)).map(row => [Object.keys(ops).find(name => ops[name as keyof typeof ops] === row.id), row.status]));

    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(Object.values(await statuses()).every(status => status === "running")).toBe(true);

    const first = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    expect(kindReport(first, "workspace_command_operation")).toMatchObject({ inProgress: 6, settled: 2 });
    expect(await statuses()).toEqual({ dead: "failed", live: "running", foreign: "running", legacyDone: "failed",
      legacyLive: "running", unowned: "running", runtimeControl: "running" });
    const [settled] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ops.dead));
    expect(settled.metadata).toMatchObject({ abandonedCommand: { reason: "abandoned_workspace_command", proof: "pid_dead" } });
    expect(settled.finishedAt).not.toBeNull();
  });

  it("stamps a running workspace command with the process that runs it", async () => {
    const [{ id: runId }] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      invocationSource: "manual" }).returning({ id: heartbeatRuns.id });
    const recorder = workspaceOperationService(db).createRecorder({ companyId, heartbeatRunId: runId });
    let stamped: unknown;
    await recorder.recordOperation({ phase: "workspace_provision", command: "true", run: async () => {
      const [row] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      stamped = row.metadata;
      return { status: "succeeded", exitCode: 0 };
    } });
    expect(stamped).toMatchObject({ commandOwner: { bootId: currentControllerBootId(), pid: process.pid } });
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
      status: "skipped", reason: "company.inactive", requestedByActorType: "user", error: "Company is not active" })));
    const report = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(report.violations.filter(violation => violation.rule === "I4_exactly_once_intent")
      .map(violation => violation.recordId).sort()).toEqual([...refused].sort());
    const again = await runOwnershipReconciliationPass(db, { state, record: false, limitPerKind: 2 });
    expect(again.violations.filter(violation => violation.rule === "I4_exactly_once_intent")).toEqual([]);
  });

  // Section E: I4 reads the closed refusal code, not free text. Phase 2's
  // false positive was a delivered retry whose error said "retrying once".
  it("does not report a wake whose error text only mentions a retry", async () => {
    const state = createOwnershipReportState();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", status: "failed",
      reason: "process_lost", requestedByActorType: "user", error: "Process lost; retrying once" });
    const report = await runOwnershipReconciliationPass(db, { state, record: false });
    expect(report.violations.filter(violation => violation.rule === "I4_exactly_once_intent")).toEqual([]);
  });

  it("reports a saved message whose pause lifted without promotion, and not one still paused", async () => {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({ id, companyId, agentId, source: "automation", status: "deferred_issue_execution",
      requestedByActorType: "user", updatedAt: minutesAgo(10),
      payload: { executionWait: { reason: "agent.not_invokable", trigger: "pause_lifted" } } });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const paused = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(paused.violations.filter(violation => violation.kind === "wake_request_deferred")).toEqual([]);
    expect(kindReport(paused, "wake_request_deferred")).toMatchObject({ inProgress: 1, verdicts: { alive: 1 } });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    const lifted = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(lifted.violations.filter(violation => violation.kind === "wake_request_deferred")).toEqual([
      expect.objectContaining({ rule: "I4_exactly_once_intent", recordId: id, reason: "deferred_after_hold_cleared" })]);
  });

  it("does not report a hard-stop refusal or a message saved behind a live run", async () => {
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", status: "skipped",
      reason: "budget.blocked", requestedByActorType: "user", error: "Company is paused because its budget hard-stop was reached." });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Busy", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "running", invocationSource: "manual",
      contextSnapshot: { issueId } });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "deferred_issue_execution",
      requestedByActorType: "user", updatedAt: minutesAgo(10),
      payload: { issueId, executionWait: { reason: "agent.not_invokable", trigger: "pause_lifted" } } });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.rule === "I4_exactly_once_intent")).toEqual([]);
  });

  // Reconciler rule (chaos s9401/t69): an undelivered user comment newer than
  // the task's last run gets a wake. A carried, a too-young, or an
  // already-read comment does not fire it.
  it("finds a user comment newer than the task's last run that no wake carries", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reopened", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "manual",
      runtimeMode: "native", contextSnapshot: { issueId }, startedAt: minutesAgo(5), createdAt: minutesAgo(5), finishedAt: minutesAgo(4) });
    const [lost, carried, young] = await db.insert(issueComments).values([
      { companyId, issueId, authorUserId: "user-1", body: "lost wake", createdAt: minutesAgo(2) },
      { companyId, issueId, authorUserId: "user-1", body: "carried", createdAt: minutesAgo(2) },
      { companyId, issueId, authorUserId: "user-1", body: "young", createdAt: new Date(Date.now() - 5_000) },
    ]).returning();
    // An agent's own comment written under its user (local CLI) is not user intent.
    await db.insert(issueComments).values({ companyId, issueId, authorUserId: "user-1", authorAgentId: agentId,
      body: "self", createdAt: minutesAgo(2) });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued",
      payload: { issueId, commentId: carried.id } });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false,
      processStartedAt: minutesAgo(10) });
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId)).toEqual([lost.id]);
    // The young comment may still get its normal wake: a deadline, not a report.
    expect(report.nextDueAt?.getTime()).toBe(young.createdAt.getTime() + 30_000);
    // A run that started after the comment read it.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "manual",
      contextSnapshot: { issueId }, startedAt: minutesAgo(1), createdAt: minutesAgo(1), finishedAt: new Date() });
    const later = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false,
      processStartedAt: minutesAgo(10) });
    expect(later.violations.filter(row => row.reason === "user_comment_without_wake")).toEqual([]);
  });

  it("finds at once a young user comment whose wake a restart lost after the board stopped the run", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped then continued", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", invocationSource: "assignment",
      runtimeMode: "native", contextSnapshot: { issueId }, startedAt: minutesAgo(4), createdAt: minutesAgo(4), finishedAt: minutesAgo(1) });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "user-1",
      body: "I stopped your previous run on purpose. Please continue.", createdAt: new Date(Date.now() - 12_000) }).returning();
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false,
      processStartedAt: new Date(Date.now() - 2_000) });
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId))
      .toEqual([comment!.id]);
    const sameProcess = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false,
      processStartedAt: minutesAgo(10) });
    expect(sameProcess.violations.filter(row => row.reason === "user_comment_without_wake")).toEqual([]);
    expect(sameProcess.nextDueAt?.getTime()).toBe(comment!.createdAt.getTime() + 30_000);
  });

  it("finds a user comment that a restart left without a wake on a task its agent then closed", async () => {
    const closedTask = async (actorType: "agent" | "user") => {
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: `Closed by ${actorType}`, status: "done", assigneeAgentId: agentId });
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "manual",
        runtimeMode: "native", contextSnapshot: { issueId }, startedAt: minutesAgo(6), createdAt: minutesAgo(6), finishedAt: minutesAgo(1) })
        .returning();
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "user-1",
        body: "also add a follow-up line", createdAt: minutesAgo(4) }).returning();
      await db.insert(activityLog).values({ companyId, actorType, actorId: actorType === "agent" ? agentId : "user-1",
        action: "issue.updated", entityType: "issue", entityId: issueId, details: { toStatus: "done" }, createdAt: minutesAgo(1) });
      return { issueId, runId: run!.id, commentId: comment!.id };
    };
    const lost = await closedTask("agent");
    const steered = await closedTask("agent");
    const goalSteered = await closedTask("agent");
    const personClosed = await closedTask("user");
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId: steered.runId, agentId, seq: 1, eventType: "item.completed", stream: "system", level: "info",
        sourceEventId: randomUUID(), payload: { prpEvent: { itemId: `provider-item-9f2:steer:${steered.commentId}`,
          payload: { kind: "steering_acknowledgement" } } } },
      { companyId, runId: goalSteered.runId, agentId, seq: 1, eventType: "item.started", stream: "system", level: "info",
        sourceEventId: randomUUID(), payload: { prpEvent: { itemId: "msg_provider_generated_7c1",
          payload: { kind: "userMessage", commandId: `goal_comment_${goalSteered.commentId}` } } } },
    ]);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId))
      .toEqual([lost.commentId]);
  });

  // The check reads a task's runs through two separate bindings (legacy
  // context or native column) and reads event payloads only for comments that
  // the indexed checks keep. Each binding must count alone, and only in the
  // comment's company.
  it("binds each task run by its legacy context or its native column in the user-comment wake check", async () => {
    const otherCompanyId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTH" });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer", adapterType: "codex_local" });
    const task = async (title: string, runs: Array<{ binding: "context" | "native" | "both"; status?: string;
      startedAt: Date; finishedAt?: Date | null; companyId?: string }>, commentAt: Date) => {
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title, status: "todo", assigneeAgentId: agentId });
      const runIds: string[] = [];
      for (const run of runs) {
        const runCompanyId = run.companyId ?? companyId;
        const [row] = await db.insert(heartbeatRuns).values({ companyId: runCompanyId, agentId: runCompanyId === companyId ? agentId : otherAgentId,
          status: run.status ?? "succeeded", invocationSource: "manual",
          contextSnapshot: run.binding === "native" ? {} : { issueId },
          nativeIssueId: run.binding === "context" ? null : issueId,
          startedAt: run.startedAt, createdAt: run.startedAt, finishedAt: run.finishedAt === undefined ? minutesAgo(3) : run.finishedAt }).returning();
        runIds.push(row!.id);
      }
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "user-1", body: title,
        createdAt: commentAt }).returning();
      return { issueId, runIds, commentId: comment!.id };
    };
    const steerEvent = (runId: string, commentId: string, eventType: string, createdAt: Date) => ({ companyId, runId, agentId,
      seq: 1, eventType, stream: "system", level: "info", sourceEventId: randomUUID(), createdAt,
      payload: { prpEvent: { itemId: `provider:steer:${commentId}`, payload: { kind: "steering_acknowledgement" } } } });
    const lostNative = await task("lost, native prior run", [{ binding: "native", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) }], minutesAgo(8));
    const lostContext = await task("lost, legacy prior run", [{ binding: "context", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) }], minutesAgo(7));
    await task("no run at all", [], minutesAgo(8));
    await task("only another company's run", [{ binding: "both", startedAt: minutesAgo(10), finishedAt: minutesAgo(9), companyId: otherCompanyId }], minutesAgo(8));
    await task("native later run", [{ binding: "context", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) },
      { binding: "native", startedAt: minutesAgo(5) }], minutesAgo(8));
    await task("legacy later run", [{ binding: "native", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) },
      { binding: "context", startedAt: minutesAgo(5) }], minutesAgo(8));
    await task("native live run", [{ binding: "native", status: "running", startedAt: minutesAgo(10), finishedAt: null }], minutesAgo(8));
    const nativeSteered = await task("native steered run", [{ binding: "native", startedAt: minutesAgo(10) }], minutesAgo(8));
    const contextSteered = await task("legacy steered run", [{ binding: "context", startedAt: minutesAgo(10) }], minutesAgo(8));
    const earlyAck = await task("acknowledged before the comment", [{ binding: "native", startedAt: minutesAgo(10) }], minutesAgo(6));
    const logOnly = await task("named only in a log event", [{ binding: "context", startedAt: minutesAgo(10) }], minutesAgo(5));
    const otherRunAck = await task("acknowledged by a run that started after it", [{ binding: "native", startedAt: minutesAgo(10), finishedAt: minutesAgo(9) }], minutesAgo(4));
    await db.insert(heartbeatRunEvents).values([
      steerEvent(nativeSteered.runIds[0]!, nativeSteered.commentId, "item.completed", minutesAgo(7)),
      steerEvent(contextSteered.runIds[0]!, contextSteered.commentId, "item.started", minutesAgo(7)),
      steerEvent(earlyAck.runIds[0]!, earlyAck.commentId, "item.completed", minutesAgo(7)),
      steerEvent(logOnly.runIds[0]!, logOnly.commentId, "log", minutesAgo(4)),
      // The run that names this comment ended before it: not a steer of this comment.
      steerEvent(otherRunAck.runIds[0]!, otherRunAck.commentId, "item.completed", minutesAgo(3)),
    ]);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false,
      processStartedAt: minutesAgo(30) });
    // Oldest first, as the check orders them.
    expect(report.violations.filter(row => row.reason === "user_comment_without_wake").map(row => row.recordId))
      .toEqual([lostNative.commentId, lostContext.commentId, earlyAck.commentId, logOnly.commentId, otherRunAck.commentId]);
  });

  // The stale-continuation check reads a task's runs through the same two
  // bindings. The closing run and a live run must each count through either
  // binding alone, and only in the comment's company and for the assignee.
  it("binds each task run by its legacy context or its native column in the stale-continuation check", async () => {
    const otherCompanyId = randomUUID(), otherAgentId = randomUUID(), peerAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTH" });
    await db.insert(agents).values([
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer", adapterType: "codex_local" },
      { id: peerAgentId, companyId, name: "Peer", role: "engineer", adapterType: "codex_local" }]);
    type Run = { binding: "context" | "native"; status?: string; startedAt: Date; finishedAt?: Date | null; companyId?: string; agentId?: string };
    const task = async (title: string, runs: Run[], commentAt: Date, options: { closedBy?: string; wake?: "commentId" | "list" | "open" } = {}) => {
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title, status: "done", assigneeAgentId: agentId });
      for (const run of runs) {
        const runCompanyId = run.companyId ?? companyId;
        await db.insert(heartbeatRuns).values({ companyId: runCompanyId, agentId: run.agentId ?? (runCompanyId === companyId ? agentId : otherAgentId),
          status: run.status ?? "succeeded", invocationSource: "manual",
          contextSnapshot: run.binding === "native" ? {} : { issueId }, nativeIssueId: run.binding === "context" ? null : issueId,
          startedAt: run.startedAt, createdAt: run.startedAt, finishedAt: run.finishedAt === undefined ? minutesAgo(2) : run.finishedAt });
      }
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "user-1", body: title,
        createdAt: commentAt }).returning();
      const commentId = comment!.id;
      const payload = options.wake === "list" ? { issueId, _paperclipWakeContext: { wakeCommentIds: [commentId] } } : { issueId, commentId };
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "cancelled",
        error: "continuation_task_ownership_changed", payload });
      if (options.wake === "open") await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
        status: "deferred_issue_execution", payload: { issueId, commentId } });
      await db.insert(activityLog).values({ companyId, actorType: options.closedBy ?? "agent", actorId: "actor", action: "issue.updated",
        entityType: "issue", entityId: issueId, details: { toStatus: "done" }, createdAt: minutesAgo(1) });
      return commentId;
    };
    const closing = (binding: Run["binding"], extra: Partial<Run> = {}): Run => ({ binding, startedAt: minutesAgo(10), ...extra });
    const nativeClosing = await task("closed by a native run", [closing("native")], minutesAgo(8));
    const contextClosing = await task("closed by a legacy run", [closing("context")], minutesAgo(7));
    const listWake = await task("carried by a wake list", [closing("native")], minutesAgo(6), { wake: "list" });
    await task("no closing run", [], minutesAgo(8));
    await task("closing run in another company", [closing("native", { companyId: otherCompanyId }), closing("context", { companyId: otherCompanyId })], minutesAgo(8));
    await task("closing run of another agent", [closing("native", { agentId: peerAgentId }), closing("context", { agentId: peerAgentId })], minutesAgo(8));
    await task("closing run failed", [closing("native", { status: "failed" })], minutesAgo(8));
    await task("closing run ended before the comment", [closing("context", { finishedAt: minutesAgo(9) })], minutesAgo(8));
    await task("closing run started after the comment", [closing("native", { startedAt: minutesAgo(7) })], minutesAgo(8));
    await task("native live run", [closing("context"), closing("native", { status: "running", startedAt: minutesAgo(3), finishedAt: null })], minutesAgo(8));
    await task("legacy live run", [closing("native"), closing("context", { status: "queued", startedAt: minutesAgo(3), finishedAt: null })], minutesAgo(8));
    const otherCompanyLive = await task("live run in another company only", [closing("native"),
      closing("context", { status: "running", companyId: otherCompanyId, finishedAt: null })], minutesAgo(5));
    await task("closed by a person", [closing("native")], minutesAgo(8), { closedBy: "user" });
    await task("an open wake carries it", [closing("context")], minutesAgo(8), { wake: "open" });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    const dropped = report.violations.filter(row => row.reason === "user_comment_dropped_by_stale_continuation");
    // Oldest first, as the check orders them. The other company's live run does not hold the last one.
    expect(dropped.map(row => row.recordId)).toEqual([nativeClosing, contextClosing, listWake, otherCompanyLive]);
    expect(dropped.every(row => row.companyId === companyId)).toBe(true);
  });

  it("keeps a backstop deadline for a lifted pause still inside its grace window", async () => {
    const updatedAt = minutesAgo(1);
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "deferred_issue_execution",
      requestedByActorType: "user", updatedAt,
      payload: { executionWait: { reason: "agent.not_invokable", trigger: "pause_lifted" } } });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.kind === "wake_request_deferred")).toEqual([]);
    // Without a release event the worker still checks again when grace ends.
    expect(report.nextDueAt?.getTime()).toBe(updatedAt.getTime() + 5 * 60_000);
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

  it("treats a current committed response-wake wait as a next action until a user answers it", async () => {
    const issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID();
    const assessmentId = randomUUID(), decisionId = randomUUID(), startedAt = minutesAgo(40);
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting for the board", status: "in_progress",
      assigneeAgentId: agentId, updatedAt: minutesAgo(30) });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", objective: "Wait", criteria: [{ id: "objective", requirement: "Wait" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "succeeded",
      nativeIssueId: issueId, nativeSessionId: runId, completionContractId: contractId, completionContractSha256: contractId,
      contextSnapshot: { issueId }, startedAt, finishedAt: minutesAgo(35) });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: "test", schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId,
      triggerKind: "turn_finished", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 1,
      policyVersion: "test", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId, assessmentId, decisionVersion: 1,
      policyVersion: "test", fromStatus: "in_progress", toStatus: "in_progress", reasonCode: "response_wake_waiting_for_input",
      decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: minutesAgo(35) });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed", resultId, assessmentId, decisionId });
    await db.update(issues).set({ lastStatusDecisionId: decisionId, updatedAt: minutesAgo(30) }).where(eq(issues.id, issueId));
    const visible = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false }))
      .violations.filter(violation => violation.rule === "I7_visible_next_action").map(violation => violation.recordId);

    expect(await visible()).toEqual([]);
    await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Go ahead.", createdAt: minutesAgo(20) });
    expect(await visible()).toEqual([issueId]);
    await db.delete(issueComments).where(eq(issueComments.issueId, issueId));
    await db.update(issues).set({ lastStatusDecisionId: null, updatedAt: minutesAgo(30) }).where(eq(issues.id, issueId));
    expect(await visible()).toEqual([issueId]);
  });

  it("returns the end of the next-action grace window for an issue still inside it", async () => {
    const updatedAt = minutesAgo(2);
    await db.insert(issues).values({ companyId, title: "Fresh", status: "in_progress", assigneeAgentId: agentId, updatedAt });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.rule === "I7_visible_next_action")).toEqual([]);
    expect(report.nextDueAt?.getTime()).toBe(updatedAt.getTime() + 5 * 60_000);
  });

  it("reports and re-drives a queued run that no dispatch started while its agent had nothing running", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continuation", status: "in_progress", assigneeAgentId: agentId });
    const [stranded] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId }, createdAt: minutesAgo(19) }).returning();
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.queuedRunDispatch, event => signals.push(event));
    try {
      const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
      expect(report.violations.filter(violation => violation.kind === "queued_run")).toEqual([
        expect.objectContaining({ rule: "I7_visible_next_action", recordId: stranded!.id, runId: stranded!.id,
          issueId, companyId, reason: "queued_run_not_dispatched" })]);
      await applyOwnershipReportBackstops(db, report);
      expect(signals).toContain("settled");
    } finally { unsubscribe(); }
  });

  it("finds a stranded run behind older queued rows past the first page, and re-drives it only once", async () => {
    const otherCompany = randomUUID();
    const otherAgent = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Held queue", issuePrefix: "HLD" });
    await db.insert(agents).values({ id: otherAgent, companyId: otherCompany, name: "Held", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values([40, 39, 38].map(minutes =>
      ({ companyId: otherCompany, agentId: otherAgent, status: "queued", invocationSource: "automation", createdAt: minutesAgo(minutes) })));
    const [stranded] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation",
      createdAt: minutesAgo(19) }).returning();
    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state, limitPerKind: 2 });
    expect(first.violations.filter(violation => violation.kind === "queued_run").map(violation => violation.recordId))
      .toContain(stranded!.id);
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.queuedRunDispatch, event => signals.push(event));
    try {
      await applyOwnershipReportBackstops(db, first);
      expect(signals).toContain("settled");
      signals.length = 0;
      const second = await runOwnershipReconciliationPass(db, { state, limitPerKind: 2 });
      expect(second.violations.filter(violation => violation.kind === "queued_run")).toHaveLength(4);
      await applyOwnershipReportBackstops(db, second);
      expect(signals).toEqual([]);
    } finally { unsubscribe(); }
  });

  it("does not report queued runs a worktree runtime will never start: before its cutoff or while execution is off", async () => {
    const copied = randomUUID();
    await db.insert(heartbeatRuns).values({ id: copied, companyId, agentId, status: "queued", invocationSource: "automation",
      createdAt: minutesAgo(19) });
    const queuedRunViolations = async () => (await runOwnershipReconciliationPass(db,
      { state: createOwnershipReportState(), record: false })).violations.filter(violation => violation.kind === "queued_run");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "true");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ownership-worktree");
    const settings = instanceSettingsService(db);
    try {
      expect(await queuedRunViolations()).toEqual([]);
      await settings.updateExperimental({ enableWorktreeRunExecution: true });
      expect(await queuedRunViolations()).toEqual([]);
      expect(await listUndispatchedQueuedRuns(db, { createdAfter: minutesAgo(1) })).toEqual([]);
      expect((await listUndispatchedQueuedRuns(db)).map(run => run.runId)).toEqual([copied]);
    } finally {
      await settings.updateExperimental({ enableWorktreeRunExecution: false });
      vi.unstubAllEnvs();
      vi.stubEnv("PAPERCLIP_HOME", home);
      vi.stubEnv("SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR", orphanSpool);
    }
  });

  it("reads undispatched queued runs in bounded slices that resume from a cursor, and skips an agent with a scheduled retry", async () => {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const created = [30, 29, 28].map(minutesAgo);
    const runs = await db.insert(heartbeatRuns).values(created.map(createdAt =>
      ({ companyId, agentId, status: "queued", invocationSource: "automation", createdAt }))).returning();
    const first = await readUndispatchedQueuedRuns(db, { pageSize: 1, maxRuns: 2 });
    expect(first.runs.map(run => run.runId)).toEqual([runs[0]!.id, runs[1]!.id]);
    expect(first.next).not.toBeNull();
    const rest = await readUndispatchedQueuedRuns(db, { pageSize: 1, maxRuns: 2, after: first.next });
    expect(rest).toEqual({ runs: [expect.objectContaining({ runId: runs[2]!.id })], next: null });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "scheduled_retry", invocationSource: "automation",
      scheduledRetryAt: new Date(Date.now() + 60_000) });
    expect(await listUndispatchedQueuedRuns(db)).toEqual([]);
  });

  it("re-drives a queued run while its agent still has a free slot, and not once every slot is running", async () => {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } }).where(eq(agents.id, agentId));
    const tasks = await db.insert(issues).values([0, 1, 2, 3].map(index =>
      ({ companyId, title: `Task ${index}`, status: "in_progress" as const, assigneeAgentId: agentId }))).returning();
    const live = (index: number) => ({ companyId, agentId, issueId: tasks[index]!.id, status: "running" as const,
      invocationSource: "automation" as const, contextSnapshot: { issueId: tasks[index]!.id }, startedAt: minutesAgo(90) });
    await db.insert(heartbeatRuns).values([live(0), live(1)]);
    const [waiting] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: tasks[3]!.id }, createdAt: minutesAgo(20) }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: tasks[0]!.id }, createdAt: minutesAgo(25) });
    expect((await listUndispatchedQueuedRuns(db)).map(run => run.runId)).toEqual([waiting!.id]);
    await db.insert(heartbeatRuns).values(live(2));
    expect(await listUndispatchedQueuedRuns(db)).toEqual([]);
  });

  it("counts an agent's live runs in one grouped aggregate, not once per queued run", async () => {
    await db.insert(heartbeatRuns).values(Array.from({ length: 5 }, () =>
      ({ companyId, agentId, status: "queued" as const, invocationSource: "automation" as const, createdAt: minutesAgo(20) })));
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation" });
    const query = undispatchedQueuedRunPageQuery(db, undefined, null, null, 500).toSQL();
    const [row] = await db.$client.unsafe(`explain (format json) ${query.sql}`, query.params as never[]);
    type PlanNode = { "Node Type": string; "Parent Relationship"?: string; Plans?: PlanNode[] };
    const aggregates: PlanNode[] = [];
    const subPlanAggregates: PlanNode[] = [];
    const walk = (node: PlanNode, inSubPlan: boolean) => {
      const subPlan = inSubPlan || node["Parent Relationship"] === "SubPlan";
      if (node["Node Type"] === "Aggregate") (subPlan ? subPlanAggregates : aggregates).push(node);
      for (const child of node.Plans ?? []) walk(child, subPlan);
    };
    walk((row as unknown as { "QUERY PLAN": Array<{ Plan: PlanNode }> })["QUERY PLAN"][0]!.Plan, false);
    expect(aggregates).toHaveLength(1);
    expect(subPlanAggregates).toEqual([]);
  });

  it("uses the agent's single-run limit for a runner provider that runs one turn at a time", async () => {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } } }).where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation",
      startedAt: minutesAgo(90) });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation",
      createdAt: minutesAgo(20) });
    expect(await listUndispatchedQueuedRuns(db)).toEqual([]);
  });

  it("keeps the earliest grace deadline when the queued-run check reaches its cap, and rescans once it ends", async () => {
    const createdAt = minutesAgo(1);
    await db.insert(heartbeatRuns).values(Array.from({ length: 2_000 }, () =>
      ({ companyId, agentId, status: "queued", invocationSource: "automation", createdAt })));
    const dueAt = createdAt.getTime() + 5 * 60_000;
    const state = createOwnershipReportState();
    const queuedRuns = (report: OwnershipReport) => report.violations.filter(violation => violation.kind === "queued_run");
    const first = await runOwnershipReconciliationPass(db, { state, record: false });
    expect(queuedRuns(first)).toEqual([]);
    expect(first.retryNeeded).toBe(true);
    expect(first.nextDueAt?.getTime()).toBeLessThanOrEqual(dueAt);
    const tail = await runOwnershipReconciliationPass(db, { state, record: false });
    expect(queuedRuns(tail)).toEqual([]);
    expect(tail.nextDueAt?.getTime()).toBeLessThanOrEqual(dueAt);
    const overdue = await runOwnershipReconciliationPass(db, { state, record: false, now: new Date(dueAt + 1) });
    expect(queuedRuns(overdue)).toHaveLength(2_000);
  }, 60_000);

  it("signals queued-run dispatch when finalization work settles or a finished coordinator's lapsed owner is released", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Settling", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "automation",
      runtimeMode: "native", nativeIssueId: issueId, finishedAt: minutesAgo(2) });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "committed",
      leaseOwner: "native-finalizer:lapsed", leaseExpiresAt: minutesAgo(1) });
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.queuedRunDispatch, event => signals.push(event));
    try {
      await db.transaction(tx => notifyNativeFinalizationWork(tx, { companyId, runId, issueId }));
      expect(signals).toContain("settled");
      signals.length = 0;
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(await db.transaction(tx => releaseLapsedCoordinatorOwner(tx, { companyId, runId }, coordinator, new Date()))).toBe(true);
      expect(signals).toContain("settled");
    } finally { unsubscribe(); }
  });

  it("does not report a queued run behind a running run, on a paused agent, or still inside its grace window", async () => {
    const otherAgent = randomUUID();
    const pausedAgent = randomUUID();
    await db.insert(agents).values([
      { id: otherAgent, companyId, name: "Busy", role: "engineer", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: pausedAgent, companyId, name: "Paused", role: "engineer", adapterType: "codex_local", status: "paused" },
    ]);
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: otherAgent, status: "running", invocationSource: "manual" },
      { companyId, agentId: otherAgent, status: "queued", invocationSource: "automation", createdAt: minutesAgo(30) },
      { companyId, agentId: pausedAgent, status: "queued", invocationSource: "automation", createdAt: minutesAgo(30) },
    ]);
    const createdAt = minutesAgo(1);
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation", createdAt });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.violations.filter(violation => violation.kind === "queued_run")).toEqual([]);
    expect(report.nextDueAt?.getTime()).toBeLessThanOrEqual(createdAt.getTime() + 5 * 60_000);
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
