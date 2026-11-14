import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  createOwnershipReportState,
  runOwnershipReconciliationPass,
  type OwnershipReport,
} from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";

const aborted = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ abortIncompleteUploads: async (_companyId: string, key: string) => { aborted.keys.push(key); return 1; } }),
}));

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const kindReport = (report: OwnershipReport, kind: string) => report.kinds.find(entry => entry.kind === kind)!;
const ledgerViolations = (report: OwnershipReport) =>
  report.violations.filter(violation => violation.kind === "remote_snapshot_ledger");
const quiesced = { schema: "paperclip.remote-workspace-save-work.v1", activeIds: [], unknown: false,
  owners: {}, quiescedAt: minutesAgo(30).toISOString() };

describe("remote snapshot ledger settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("remote-snapshot-ledger-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate execution_workspace_snapshots, activity_log, workspace_operations, execution_workspaces,
      heartbeat_runs, agents, companies cascade`);
    companyId = randomUUID(); agentId = randomUUID(); aborted.keys = [];
    await db.insert(companies).values({ id: companyId, name: "Ledger fixture", issuePrefix: "LED" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  });

  async function run(status: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status, invocationSource: "manual",
      ...(status === "running" ? {} : { finishedAt: minutesAgo(2), errorCode: "process_lost" }) });
    return id;
  }

  async function workspace(authority: { epoch: number; writerRunId: string | null; dirty: boolean }) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({ id, companyId, mode: "isolated_workspace", strategyType: "test", name: id,
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", snapshotId: null,
        source: { kind: "git", repoUrl: "https://example.invalid/repo.git", ref: null }, location: null, ...authority } } });
    return id;
  }

  async function save(input: { workspaceId: string; runId: string; epoch?: number; status?: string;
    saveWork?: Record<string, unknown>; snapshot?: Partial<typeof executionWorkspaceSnapshots.$inferInsert>; lastFailure?: boolean }) {
    const operationId = randomUUID(), snapshotId = randomUUID(), epoch = input.epoch ?? 1;
    await db.insert(workspaceOperations).values({ id: operationId, companyId, executionWorkspaceId: input.workspaceId,
      heartbeatRunId: input.runId, phase: "remote_workspace_snapshot", status: input.status ?? "failed",
      metadata: { epoch, boundary: "initial", generation: 1, saveWork: input.saveWork ?? quiesced,
        exportCleanup: { state: "pending" },
        ...(input.lastFailure === false ? {} : { lastFailure: { code: "remote_workspace_save_abandoned", at: minutesAgo(20).toISOString() } }) } });
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId: input.workspaceId,
      sourceOperationId: operationId, sourceRunId: input.runId, generation: 1, epoch,
      deleteAfter: new Date(Date.now() + 7 * 86400_000), createdAt: minutesAgo(30), updatedAt: minutesAgo(30), ...input.snapshot });
    return { operationId, snapshotId };
  }

  const ledger = async (id: string) =>
    (await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, id)))[0]!;

  it("retires a pending row an older build left behind once its save was abandoned and its epoch ended", async () => {
    const failed = await run("failed");
    const workspaceId = await workspace({ epoch: 3, writerRunId: null, dirty: false });
    const { snapshotId } = await save({ workspaceId, runId: failed });

    const state = createOwnershipReportState();
    const first = await runOwnershipReconciliationPass(db, { state });
    const second = await runOwnershipReconciliationPass(db, { state });

    expect(kindReport(first, "remote_snapshot_ledger")).toMatchObject({ inProgress: 1, settled: 1 });
    expect(ledgerViolations(first)).toEqual([]);
    expect(ledgerViolations(second)).toEqual([]);
    expect(kindReport(second, "remote_snapshot_ledger").inProgress).toBe(0);
    const row = await ledger(snapshotId);
    expect(row).toMatchObject({ status: "deleted", deleteAfter: null, lastError: "abandoned_remote_snapshot_upload" });
    expect(row.metadata).toMatchObject({ abandonedUpload: { schema: "paperclip.remote-snapshot-ledger-abandonment.v1",
      runId: failed, epoch: 1, workspaceEpoch: 3, uploadAttempted: false, previousStatus: "pending" } });
  });

  it("leaves objects of an attempted upload to retention, and never retires an uploaded, committed or still-owned row", async () => {
    const failed = await run("failed"), live = await run("running"), writer = await run("failed");
    const ended = await workspace({ epoch: 2, writerRunId: null, dirty: false });
    const held = await workspace({ epoch: 1, writerRunId: writer, dirty: true });
    const objectKey = `${companyId}/workspace-snapshots/${ended}/x/a.pcws`;
    const rows = {
      attempted: await save({ workspaceId: ended, runId: failed, snapshot: { metadata: { uploads: [{ objectKey }] } } }),
      uploaded: await save({ workspaceId: await workspace({ epoch: 2, writerRunId: null, dirty: false }), runId: failed,
        snapshot: { status: "uploaded", objectKey } }),
      liveRun: await save({ workspaceId: await workspace({ epoch: 2, writerRunId: null, dirty: false }), runId: live }),
      reopened: await save({ workspaceId: await workspace({ epoch: 2, writerRunId: null, dirty: false }), runId: failed,
        status: "running", lastFailure: false }),
      currentWriter: await save({ workspaceId: held, runId: writer }),
    };
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
      kinds: OWNABLE_KINDS.filter(kind => kind.id === "remote_snapshot_ledger") });

    expect(await ledger(rows.attempted.snapshotId)).toMatchObject({ status: "delete_requested",
      metadata: { uploads: [{ objectKey }], abandonedUpload: { uploadAttempted: true } } });
    expect((await ledger(rows.attempted.snapshotId)).deleteAfter).not.toBeNull();
    expect((await ledger(rows.uploaded.snapshotId)).status).toBe("uploaded");
    expect((await ledger(rows.liveRun.snapshotId)).status).toBe("pending");
    expect((await ledger(rows.reopened.snapshotId)).status).toBe("pending");
    expect((await ledger(rows.currentWriter.snapshotId)).status).toBe("pending");
  });

  it("retires the ledger row in the same settle that abandons a save a restart stopped mid-upload", async () => {
    const failed = await run("failed");
    const workspaceId = await workspace({ epoch: 2, writerRunId: null, dirty: false });
    const { operationId, snapshotId } = await save({ workspaceId, runId: failed, status: "running", lastFailure: false });

    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
      kinds: OWNABLE_KINDS.filter(kind => kind.id === "remote_snapshot_save") });

    expect(kindReport(report, "remote_snapshot_save")).toMatchObject({ settled: 1 });
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationId));
    expect(operation!.metadata).toMatchObject({ lastFailure: { code: "remote_workspace_save_abandoned" } });
    expect(await ledger(snapshotId)).toMatchObject({ status: "deleted",
      metadata: { abandonedUpload: { runId: failed, operationId } } });
  });

  it("aborts the incomplete multipart uploads of every attempt when the reconciler retires an abandoned save", async () => {
    const failed = await run("failed");
    const ledgerWorkspace = await workspace({ epoch: 2, writerRunId: null, dirty: false });
    const ledgerId = randomUUID(), ledgerKeys = ["a", "b"].map(name => `${companyId}/workspace-snapshots/${ledgerWorkspace}/${ledgerId}/${name}.pcws`);
    await save({ workspaceId: ledgerWorkspace, runId: failed,
      snapshot: { id: ledgerId, metadata: { uploads: [...ledgerKeys.map(objectKey => ({ objectKey })), { objectKey: `${companyId}/elsewhere/c.pcws` }] } } });
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
      kinds: OWNABLE_KINDS.filter(kind => kind.id === "remote_snapshot_ledger") });
    expect(aborted.keys).toEqual(ledgerKeys);

    aborted.keys = [];
    const saveWorkspace = await workspace({ epoch: 2, writerRunId: null, dirty: false });
    const saveId = randomUUID(), saveKey = `${companyId}/workspace-snapshots/${saveWorkspace}/${saveId}/cut.pcws`;
    await save({ workspaceId: saveWorkspace, runId: failed, status: "running", lastFailure: false,
      snapshot: { id: saveId, metadata: { uploads: [{ objectKey: saveKey }] } } });
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(),
      kinds: OWNABLE_KINDS.filter(kind => kind.id === "remote_snapshot_save") });
    expect(await ledger(saveId)).toMatchObject({ status: "delete_requested" });
    expect(aborted.keys).toEqual([saveKey]);
  });
});
