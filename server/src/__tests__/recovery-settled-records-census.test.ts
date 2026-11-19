import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns,
  issues, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "../services/execution-control-work.js";
import { registerOwnershipReconciliationWork } from "../services/native-runtime/native-finalization-reconciler.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { createOwnershipReportState, recheckSettlingKinds, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { invalidateNativeReplacementDiscovery, reconcileSafeNativeReplacements } from "../services/native-runtime/native-safe-replacement.js";
import { notifyRunDispatch } from "../services/run-dispatch-notifications.js";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const quiesced = () => ({ schema: "paperclip.remote-workspace-save-work.v1", activeIds: [], unknown: false,
  owners: {}, quiescedAt: minutesAgo(600).toISOString() });

type Census = { statements: number; locks: number; byShape: Map<string, { count: number; locks: number }> };

function shapeOf(query: string) {
  const text = query.replace(/\s+/g, " ").trim();
  const table = /\bfrom "?([a-z_]+)"?/i.exec(text)?.[1] ?? /^(?:update|insert into) "?([a-z_]+)"?/i.exec(text)?.[1] ?? "?";
  const verb = text.split(" ")[0]!.toLowerCase();
  return `${verb} ${table}${/ for (update|share|no key update)\b/i.test(text) ? " FOR UPDATE" : ""}`;
}

function callerOf(stack: string) {
  const frame = stack.split("\n").slice(1).find(line => line.includes("/server/src/services/")
    && !line.includes("delivery-work-coordinator") && !line.includes("task-admission") && !line.includes("activity-log"));
  const match = frame && /services\/([^:)]+):(\d+)/.exec(frame);
  return match ? `${match[1]}:${match[2]}` : "?";
}

describe.skipIf(!support.supported)("recovery passes over settled records (census)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  let home: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  let companyId: string, agentId: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "recovery-census-home-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR", join(home, "orphan-spool"));
    database = await startEmbeddedPostgresTestDatabase("recovery-settled-census-");
    db = createDb(database.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    meter = meterDatabaseStatements(db, database.connectionString);
  }, 120_000);
  afterAll(async () => {
    meter?.uninstall(); await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.execute(sql`truncate execution_workspace_snapshots, workspace_operations, execution_workspaces, activity_log,
      native_run_finalizations, heartbeat_runs, issues, agents, companies cascade`);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Census", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "paperclip_runner" });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers();
    expect(errors.splice(0)).toEqual([]);
  });

  const runRow = (values: Partial<typeof heartbeatRuns.$inferInsert> = {}) => ({ id: randomUUID(), companyId, agentId,
    status: "failed", invocationSource: "manual", finishedAt: minutesAgo(600), errorCode: "process_lost", ...values });

  const workspaceRow = (authority: { epoch: number; writerRunId: string | null; dirty: boolean; location?: boolean }) => {
    const id = randomUUID();
    return { id, companyId, mode: "isolated_workspace", strategyType: "test", name: id,
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: authority.epoch, snapshotId: null,
        source: { kind: "git", repoUrl: "https://example.invalid/repo.git", ref: null }, dirty: authority.dirty,
        writerRunId: authority.writerRunId,
        location: authority.location ? { environmentId: randomUUID(), leaseId: randomUUID(), providerLeaseId: `sandbox-${id}`,
          remoteCwd: "/workspace/root" } : null } } };
  };

  type Rows = { runs: Array<ReturnType<typeof runRow>>; workspaces: Array<ReturnType<typeof workspaceRow>>;
    operations: Array<typeof workspaceOperations.$inferInsert>; snapshots: Array<typeof executionWorkspaceSnapshots.$inferInsert> };

  function ledgerRow(rows: Rows, input: { workspaceId: string; runId: string; epoch: number; status: "pending" | "uploaded"; objectKey?: string | null }) {
    const operationId = randomUUID(), snapshotId = randomUUID();
    rows.operations.push({ id: operationId, companyId, executionWorkspaceId: input.workspaceId,
      heartbeatRunId: input.runId, phase: "remote_workspace_snapshot", status: "failed",
      metadata: { epoch: input.epoch, boundary: "final", generation: 1, saveWork: quiesced() } });
    rows.snapshots.push({ id: snapshotId, companyId, executionWorkspaceId: input.workspaceId,
      sourceOperationId: operationId, sourceRunId: input.runId, generation: 1, epoch: input.epoch, status: input.status,
      objectKey: input.objectKey ?? null, deleteAfter: new Date(Date.now() + 7 * 86400_000), createdAt: minutesAgo(600),
      updatedAt: minutesAgo(600) });
    return snapshotId;
  }

  async function insert(rows: Rows) {
    if (rows.runs.length) await db.insert(heartbeatRuns).values(rows.runs);
    if (rows.workspaces.length) await db.insert(executionWorkspaces).values(rows.workspaces);
    if (rows.operations.length) await db.insert(workspaceOperations).values(rows.operations);
    if (rows.snapshots.length) await db.insert(executionWorkspaceSnapshots).values(rows.snapshots);
  }

  /** The staging shape: history that recovery can no longer change, plus a few live runs. */
  async function seedStagingShape() {
    const rows: Rows = { runs: [], workspaces: [], operations: [], snapshots: [] };
    for (let index = 0; index < 100; index++) {
      const writer = runRow(index % 2 === 0 ? { executionStage: "executing", runtimeMode: "native",
        runtimeModeResolvedAt: minutesAgo(601) } : { status: "succeeded", executionStage: "executing" });
      const workspace = workspaceRow({ epoch: 1, writerRunId: writer.id, dirty: true, location: true });
      rows.runs.push(writer); rows.workspaces.push(workspace);
      if (index % 2 === 0) ledgerRow(rows, { workspaceId: workspace.id, runId: writer.id, epoch: 1, status: "pending" });
    }
    for (let index = 0; index < 100; index++) {
      const source = runRow({ status: "succeeded" });
      const workspace = workspaceRow({ epoch: 2, writerRunId: null, dirty: false });
      rows.runs.push(source); rows.workspaces.push(workspace);
      ledgerRow(rows, { workspaceId: workspace.id, runId: source.id, epoch: 1, status: "uploaded",
        objectKey: `${companyId}/snapshots/${index}.pcws` });
    }
    const finished: Array<typeof issues.$inferInsert> = [], finalizations: Array<typeof nativeRunFinalizations.$inferInsert> = [];
    for (let index = 0; index < 20; index++) {
      const issueId = randomUUID();
      finished.push({ id: issueId, companyId, title: `Finished ${index}`, status: "done", assigneeAgentId: agentId });
      const failed = runRow({ runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId },
        runnerProfileJson: { recoveryEventInventoryVersion: 1, nativeExecutionInput: { provider: { kind: "codex" },
          workspace: { cwd: tmpdir() } } } });
      rows.runs.push(failed);
      finalizations.push({ runId: failed.id, companyId, issueId, phase: "terminal_failure", attempt: 1,
        failureCode: "native_provider_terminal_failed", failureDetail: { originalFailureCode: "fixture_checkpoint_unusable" } });
    }
    const live: Array<{ runId: string; issueId: string }> = [];
    for (let index = 0; index < 7; index++) {
      const issueId = randomUUID();
      const liveRun = runRow({ status: "running", runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId },
        finishedAt: null, errorCode: null, startedAt: minutesAgo(1) });
      finished.push({ id: issueId, companyId, title: `Live ${index}`, status: "in_progress", assigneeAgentId: agentId });
      rows.runs.push(liveRun);
      live.push({ runId: liveRun.id, issueId });
    }
    await db.insert(issues).values(finished);
    await insert(rows);
    await db.insert(nativeRunFinalizations).values(finalizations);
    for (const entry of live) await db.update(issues).set({ executionRunId: entry.runId }).where(sql`id = ${entry.issueId}`);
    return live;
  }

  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    const ownership = registerOwnershipReconciliationWork(db, coordinator, () => true);
    const replacement = registerExecutionControlWork(coordinator, [replacementDuty()]);
    await Promise.all([ownership.ready, replacement.ready]);
  }

  function replacementDuty() {
    return { queue: DELIVERY_QUEUES.executionReplacement,
      run: () => reconcileSafeNativeReplacements(db, new Date(), { verifyStoppedSession: async () => null }),
      next: executionControlSchedule(db).replacement, onSettled: () => invalidateNativeReplacementDiscovery(db),
      settleEmptyWhilePaused: true };
  }

  async function advance(ms: number, onTick?: () => Promise<void>) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await onTick?.();
      await vi.advanceTimersByTimeAsync(Math.min(10_000, until - Date.now())); await delay(1);
      while (idleWorkSnapshot().active > 0) await delay(5);
    }
  }

  async function census(work: () => Promise<unknown>): Promise<Census> {
    const result: Census = { statements: 0, locks: 0, byShape: new Map() };
    meter.startLog({ stacks: true });
    try { await work(); } finally {
      for (const entry of meter.stopLog()) {
        const lock = / for (update|share|no key update)\b/i.test(entry.sql);
        const key = `${shapeOf(entry.sql)} <- ${callerOf(entry.stack ?? "")}`;
        const row = result.byShape.get(key) ?? { count: 0, locks: 0 };
        row.count += 1; if (lock) row.locks += 1;
        result.byShape.set(key, row);
        result.statements += 1; if (lock) result.locks += 1;
      }
    }
    return result;
  }

  function table(label: string, result: Census) {
    const rows = [...result.byShape].sort((a, b) => b[1].count - a[1].count).slice(0, 20)
      .map(([key, value]) => `  ${String(value.count).padStart(6)} ${String(value.locks).padStart(5)}  ${key}`);
    return `${label}: ${result.statements} statements, ${result.locks} row locks\n${rows.join("\n")}`;
  }

  const hint = async (live: Array<{ runId: string; issueId: string }>) => {
    for (const { runId, issueId } of live) {
      await db.transaction(async tx => {
        await notifyRunDispatch(tx, { companyId, runId, issueId });
        await notifyExecutionRunWork(tx, { companyId, runId, issueId });
      });
    }
  };

  it("counts statements and row locks of one pass of each worker over staging-shaped history", async () => {
    await seedStagingShape();
    const state = createOwnershipReportState();
    await runOwnershipReconciliationPass(db, { state });
    await runOwnershipReconciliationPass(db, { state });
    const fullPass = await census(() => runOwnershipReconciliationPass(db, { state }));
    const watchPass = await census(() => recheckSettlingKinds(db));
    const duty = replacementDuty();
    await duty.run();
    invalidateNativeReplacementDiscovery(db);
    const replacementPass = await census(async () => { await duty.run(); await duty.next(); });
    console.log([table("ownership full pass", fullPass), table("ownership watch re-check", watchPass),
      table("execution replacement pass", replacementPass)].join("\n\n"));
    const settled = (result: Census) => [...result.byShape.keys()].filter(key =>
      /remote-(workspace-unsaved-files|snapshot-ledger)-settlement/.test(key));
    expect({ full: settled(fullPass), watch: settled(watchPass) }).toEqual({ full: [], watch: [] });
    expect(fullPass.locks).toBe(0);
    expect(watchPass.statements).toBeLessThanOrEqual(30);
    expect(replacementPass.statements).toBeLessThanOrEqual(3);
  }, 300_000);

  it("runs no statements for half an hour once only settled history is left, and takes no row locks while runs are active", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const live = await seedStagingShape();
    await start(); await advance(60_000);
    await db.update(issues).set({ executionRunId: null, status: "done" }).where(sql`execution_run_id is not null`);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(sql`status = 'running'`);
    await advance(60_000);
    const idle = await census(() => advance(30 * 60_000));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
      .where(sql`id in (${sql.join(live.map(entry => sql`${entry.runId}`), sql`, `)})`);
    const active = await census(() => advance(10 * 60_000, () => hint(live)));
    console.log([table("idle 30 min", idle), table("active 10 min", active)].join("\n\n"));
    expect(idle.statements).toBe(0);
    expect(active.locks).toBe(0);
    expect([...active.byShape.keys()].filter(key => /remote-(workspace-unsaved-files|snapshot-ledger)-settlement/.test(key))).toEqual([]);
  }, 1_200_000);

  it("still settles every record that can change promptly, beside staging-shaped history", async () => {
    await seedStagingShape();
    const rows: Rows = { runs: [], workspaces: [], operations: [], snapshots: [] };
    const preparing = runRow({ executionStage: "preparing", finishedAt: minutesAgo(2) });
    const preparedWorkspace = workspaceRow({ epoch: 1, writerRunId: preparing.id, dirty: true, location: true });
    const saver = runRow({ executionStage: "executing", finishedAt: minutesAgo(2) });
    const movedWorkspace = workspaceRow({ epoch: 3, writerRunId: null, dirty: false });
    const stuckWriter = runRow({ executionStage: "executing", finishedAt: minutesAgo(2) });
    const stuckWorkspace = workspaceRow({ epoch: 1, writerRunId: stuckWriter.id, dirty: true, location: true });
    const leaseRun = runRow({ finishedAt: minutesAgo(2) });
    rows.runs.push(preparing, saver, stuckWriter, leaseRun);
    rows.workspaces.push(preparedWorkspace, movedWorkspace, stuckWorkspace);
    const abandoned = ledgerRow(rows, { workspaceId: movedWorkspace.id, runId: saver.id, epoch: 1, status: "pending" });
    const held = ledgerRow(rows, { workspaceId: stuckWorkspace.id, runId: stuckWriter.id, epoch: 1, status: "pending" });
    await insert(rows);
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: leaseRun.id, status: "active" }).returning();
    const ledger = async (id: string) => (await db.select().from(executionWorkspaceSnapshots)
      .where(eq(executionWorkspaceSnapshots.id, id)))[0]!;

    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state });
    const kind = (id: string) => first.kinds.find(entry => entry.kind === id)!;
    expect(kind("remote_workspace_unsaved_files")).toMatchObject({ settled: 1 });
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, preparedWorkspace.id)))[0]!.metadata)).toMatchObject({ dirty: false, writerRunId: null, epoch: 2 });
    expect((await ledger(abandoned)).status).toBe("deleted");
    expect((await ledger(held)).status).toBe("pending");
    expect(kind("environment_run_lease_active")).toMatchObject({ inProgress: 1, settled: 1 });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id)))[0]!.status).toBe("pending_cleanup");

    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...readRemoteWorkspaceAuthority(stuckWorkspace.metadata)!,
      epoch: 2, writerRunId: null, dirty: false, location: null } } }).where(eq(executionWorkspaces.id, stuckWorkspace.id));
    const second = await runOwnershipReconciliationPass(db, { state });
    expect(second.kinds.find(entry => entry.kind === "remote_snapshot_ledger")).toMatchObject({ settled: 1 });
    expect((await ledger(held)).status).toBe("deleted");
    const settledPass = await census(() => runOwnershipReconciliationPass(db, { state }));
    expect([...settledPass.byShape.keys()].filter(key => /remote-(workspace-unsaved-files|snapshot-ledger)-settlement/.test(key))).toEqual([]);
  }, 300_000);

  it("skips a dirty workspace whose writer id is not a UUID without failing the listing", async () => {
    const valid = runRow({ executionStage: "preparing", finishedAt: minutesAgo(2) });
    const rows: Rows = { runs: [valid], workspaces: [workspaceRow({ epoch: 1, writerRunId: valid.id, dirty: true, location: true })],
      operations: [], snapshots: [] };
    const malformed = workspaceRow({ epoch: 1, writerRunId: null, dirty: true, location: true });
    malformed.metadata.remoteWorkspace.writerRunId = "not-a-run-id" as unknown as null;
    rows.workspaces.push(malformed);
    await insert(rows);
    const kind = OWNABLE_KINDS.find(entry => entry.id === "remote_workspace_unsaved_files")!;
    const listed = await kind.listInProgress!(db, 200, 0);
    expect(listed.records.map(record => record.recordId)).toEqual([rows.workspaces[0]!.id]);
  }, 120_000);
});

