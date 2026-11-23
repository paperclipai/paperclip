import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, closeRegisteredClients, companies, createDb, environmentLeases, environments, executionWorkspaces,
  heartbeatRunEvents, heartbeatRuns, issues, nativeRunnerCheckpoints, workspaceOperations,
} from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import {
  prepareRemoteWorkspace, readRemoteWorkspaceAuthority, RemoteWorkspaceWriterActiveError, reserveRemoteWorkspace, saveRemoteWorkspace,
} from "./remote-workspaces.js";
import { UNCHANGED_BASELINE_KEY } from "./remote-workspace-unchanged-proof.js";
import { releaseUnchangedFallbackWorkspace } from "./heartbeat/predecessor-retirement-fallback.js";
import { FAILED_BEFORE_PROVIDER_TURN_KEY, FAILED_BEFORE_PROVIDER_TURN_SCHEMA } from "./native-runtime/failed-before-provider-turn.js";
import { readReplaceBeforeReuseMarker, REPLACE_BEFORE_REUSE_KEY, REPLACE_BEFORE_REUSE_SCHEMA } from "./native-runtime/predecessor-retirement.js";
import { retireReplacedReusableSandboxLease, reusableSandboxReplacementPlan } from "./reusable-sandbox-resume-replacement.js";
import { ABANDONED_WORKSPACE_FILES_PARKED_REASON, abandonedWorkspaceFilesHeldOnLease } from "./remote-workspace-abandoned-files-hold.js";
import { heartbeatService } from "./heartbeat.js";

const exec = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("remote workspace writer that ended without changing its files", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-unchanged-release-");
    db = createDb(database.connectionString);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-unchanged-release-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A saved workspace, then a follow-up writer B prepared on the same sandbox (staging PAP-3367 shape). */
  async function preparedFollowUp(options: { runtimeProvisionCommand?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Unchanged release", issuePrefix: `U${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily repair", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ name: issueId, driver: "sandbox" }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, issueId, "objects"))), provider: "s3" as const };
    const remoteCwd = path.join(root, issueId, "remote");
    await mkdir(remoteCwd, { recursive: true });
    const providerLeaseId = randomUUID();
    const transfer: NonNullable<NonNullable<AdapterSandboxExecutionTarget["runner"]>["syncIn"]> = async operations => {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId,
        filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    };
    let captures = 0;
    const target = (leaseId: string): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox", leaseId, remoteCwd, timeoutMs: 30_000,
      runner: { syncIn: transfer, syncOut: async operations => { captures += 1; return transfer(operations); },
        execute: async input => {
          const result = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? remoteCwd,
            env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, signal: null, timedOut: false,
            pid: process.pid, startedAt: new Date().toISOString() };
        } },
    });
    const writer = async (runId: string, existingWorkspaceId: string | null, runtimeProvisionCommand?: string) => {
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy",
        status: "running", contextSnapshot: { issueId } });
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
        environmentId: environment.id, provider: "daytona", providerLeaseId, status: "active" }).returning();
      const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
        environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId, source: { kind: "empty" } });
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId,
        lease: lease as EnvironmentLease, target: target(lease.id), runtimeProvisionCommand });
      return { lease: prepared.lease, workspaceId: reserved.id, remoteRoot: prepared.remoteRoot };
    };
    // Run A does real work and saves it.
    const runA = randomUUID();
    const a = await writer(runA, null);
    await writeFile(path.join(a.remoteRoot, "report.md"), "earlier work\n");
    const [workspaceA] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, a.workspaceId));
    const savedA = await saveRemoteWorkspace({ db, storage, workspace: workspaceA, runId: runA, lease: a.lease,
      target: target(a.lease.id), assertOwned: async () => undefined });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runA));
    // Run B is the follow-up: claimed, then interrupted before any provider work.
    const runB = randomUUID();
    const b = await writer(runB, a.workspaceId, options.runtimeProvisionCommand);
    const end = async (patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "operator_interrupted", ...patch })
        .where(eq(heartbeatRuns.id, runB));
    };
    const workspace = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, a.workspaceId)))[0]!;
    const saveB = async () => saveRemoteWorkspace({ db, storage, workspace: await workspace(), runId: runB, lease: b.lease,
      target: target(b.lease.id), assertOwned: async () => undefined });
    const snapshotOperations = () => db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, runB), eq(workspaceOperations.phase, "remote_workspace_snapshot")));
    const reserveNext = async () => {
      const runC = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runC, companyId, agentId, issueId, runtimeMode: "legacy",
        status: "running", contextSnapshot: { issueId } });
      return { runC, reserved: await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: runC, agentId,
        environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: a.workspaceId, source: { kind: "empty" } }) };
    };
    const parkWaiter = async () => {
      const waiterId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: waiterId, companyId, agentId, issueId, runtimeMode: "legacy",
        status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: new Date(Date.now() + 5 * 60_000),
        contextSnapshot: { issueId, workspaceBusyWait: { key: `execution:${a.workspaceId}`, holderRunId: runB,
          waitingSince: new Date().toISOString(), issueExecutionWorkspaceId: a.workspaceId, issueProjectWorkspaceId: null } } });
      return async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiterId)))[0]!.scheduledRetryAt!;
    };
    const event = (eventType: string) => db.insert(heartbeatRunEvents).values({ companyId, runId: runB, agentId,
      seq: 1, stream: "system", level: "info", eventType });
    return { companyId, runA, runB, issueId, savedA, workspace, end, saveB, snapshotOperations, reserveNext, parkWaiter, event,
      remoteRoot: b.remoteRoot, leaseB: b.lease, captures: () => captures };
  }

  async function expectFullSave(f: Awaited<ReturnType<typeof preparedFollowUp>>, changed = false) {
    await expect(f.reserveNext()).rejects.toBeInstanceOf(RemoteWorkspaceWriterActiveError);
    const before = f.captures();
    const saved = await f.saveB();
    if (changed) {
      expect(saved).not.toHaveProperty("unchanged");
      expect(saved.snapshotId).not.toBe(f.savedA.snapshotId);
    } else expect(saved).toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(f.captures()).toBeGreaterThan(before);
    expect(await f.snapshotOperations()).toHaveLength(1);
  }

  it("admits the next run at once, without a save, when the interrupted writer never started provider work", async () => {
    const f = await preparedFollowUp();
    await f.end();
    const { runC, reserved } = await f.reserveNext();
    const authority = readRemoteWorkspaceAuthority(reserved.metadata);
    expect(authority).toMatchObject({ writerRunId: runC, snapshotId: f.savedA.snapshotId, dirty: false, epoch: 3 });
    expect(await f.snapshotOperations()).toEqual([]);
    const [runB] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runB));
    expect(runB.runnerProfileJson?.remoteWorkspace).toMatchObject({ state: "saved", snapshotId: f.savedA.snapshotId, epoch: 2 });
  });

  it("settles a later save of that writer without capturing, and wakes runs parked behind it", async () => {
    const f = await preparedFollowUp();
    await f.end();
    const dueAt = await f.parkWaiter();
    // Production finalizers publish their wrapper receipt before the save.
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: (await f.workspace()).id,
      heartbeatRunId: f.runB, phase: "workspace_finalize", status: "running", metadata: { owningService: "native_workspace_finalizer" } });
    const before = f.captures();
    const saved = await f.saveB();
    expect(saved).toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(f.captures()).toBe(before);
    expect((await dueAt()).getTime()).toBeLessThanOrEqual(Date.now());
    // A repeated save (a recovery retry) returns the same version.
    expect(await f.saveB()).toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(await f.snapshotOperations()).toEqual([]);
    const { runC } = await f.reserveNext();
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)?.writerRunId).toBe(runC);
  });

  it.each(["turn.started", "provider.event", "tool.execution.started", "native.process_start_requested"])(
    "keeps the full save after a %s event", async eventType => {
      const f = await preparedFollowUp();
      await f.event(eventType);
      await f.end();
      await expectFullSave(f);
    });

  it("keeps the full save when setup wrote into the workspace", async () => {
    const f = await preparedFollowUp({ runtimeProvisionCommand: "echo provisioned > provisioned.txt" });
    await f.end();
    await expectFullSave(f, true);
  });

  // A follow-up that could not retire its predecessor fails before provider
  // work; its next attempt moves to a fresh sandbox only with nothing unsaved.
  it.each([
    { label: "an untouched workspace", provision: undefined, released: true },
    { label: "setup that wrote into the workspace", provision: "echo provisioned > provisioned.txt", released: false },
  ])("hands on the workspace of a run that could not retire its predecessor only for $label", async ({ provision, released }) => {
    const f = await preparedFollowUp(provision ? { runtimeProvisionCommand: provision } : {});
    // The heartbeat still holds the run's controller lease when it settles the failure.
    await f.end({ status: "failed", errorCode: "adapter_failed", controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId }).then(Boolean)).toBe(released);
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject(released
      ? { dirty: false, writerRunId: null, snapshotId: f.savedA.snapshotId } : { dirty: true, writerRunId: f.runB });
  });

  it.each([
    { label: "the settled predecessor's warm Runner identity", own: false, event: false, released: true },
    { label: "a Runner identity of its own", own: true, event: false, released: false },
    { label: "the predecessor's identity and its own identity record", own: false, event: true, released: false },
  ])("hands on the workspace of a follow-up that carries $label only when it never had its own Runner", async ({ own, event, released }) => {
    const f = await preparedFollowUp();
    const nativeSessionId = randomUUID(), processStartedAt = new Date(Date.now() - 60_000);
    await db.update(heartbeatRuns).set({ nativeSessionId, processPid: 41_001, processGroupId: 41_001, processStartedAt })
      .where(eq(heartbeatRuns.id, f.runA));
    await db.update(heartbeatRuns).set({ nativeSessionId, processPid: own ? 41_002 : 41_001,
      processGroupId: own ? 41_002 : 41_001, processStartedAt }).where(eq(heartbeatRuns.id, f.runB));
    if (event) await f.event("native.process_identity_recorded");
    await f.end({ status: "failed", errorCode: "native_session_interrupted", controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId }).then(Boolean)).toBe(released);
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject(released
      ? { dirty: false, writerRunId: null, snapshotId: f.savedA.snapshotId } : { dirty: true, writerRunId: f.runB });
  });

  it.each([1, 0])("queues no fallback attempt beside another writer (epoch change %i)", async epochChange => {
    const f = await preparedFollowUp();
    await f.end({ status: "failed", errorCode: "adapter_failed" });
    const current = await f.workspace();
    const authority = readRemoteWorkspaceAuthority(current.metadata)!;
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, remoteWorkspace: { ...authority,
      writerRunId: randomUUID(), epoch: authority.epoch + epochChange } } }).where(eq(executionWorkspaces.id, current.id));
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId })).toBe(false);
  });

  it("keeps the full save while the writer's owner may still act, and while it is still running", async () => {
    const f = await preparedFollowUp();
    await f.end({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    await expect(f.reserveNext()).rejects.toBeInstanceOf(RemoteWorkspaceWriterActiveError);
    await db.update(heartbeatRuns).set({ status: "running", controllerLeaseExpiresAt: null, finishedAt: null })
      .where(eq(heartbeatRuns.id, f.runB));
    const before = f.captures();
    const saved = await f.saveB();
    expect(saved).toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(f.captures()).toBeGreaterThan(before);
    expect(await f.snapshotOperations()).toHaveLength(1);
  });

  it("keeps the full save when a process was recorded", async () => {
    const f = await preparedFollowUp();
    await f.end({ processPid: 4242, processStartedAt: new Date() });
    await expectFullSave(f);
  });

  it("wakes parked runs when a full final save settles", async () => {
    const f = await preparedFollowUp();
    await f.event("turn.started");
    await f.end();
    const dueAt = await f.parkWaiter();
    await f.saveB();
    expect((await dueAt()).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    { label: "a writer prepared by the previous release (no baseline)", baseline: undefined },
    { label: "a baseline missing its saved version", baseline: "drop_snapshot" },
    { label: "a baseline from another schema", baseline: "other_schema" },
  ] as const)("keeps the full save for $label", async ({ baseline }) => {
    const f = await preparedFollowUp();
    const current = await f.workspace();
    const recorded = current.metadata?.[UNCHANGED_BASELINE_KEY] as Record<string, unknown> | undefined;
    expect(recorded).toMatchObject({ runId: f.runB, epoch: 2, snapshotId: f.savedA.snapshotId });
    const { [UNCHANGED_BASELINE_KEY]: _dropped, ...previousRelease } = current.metadata ?? {};
    const next = baseline === undefined ? previousRelease
      : baseline === "drop_snapshot" ? { ...previousRelease, [UNCHANGED_BASELINE_KEY]: { ...recorded, snapshotId: undefined } }
      : { ...previousRelease, [UNCHANGED_BASELINE_KEY]: { ...recorded, schema: "paperclip.remote-workspace-unchanged-baseline.v0" } };
    await db.update(executionWorkspaces).set({ metadata: next }).where(eq(executionWorkspaces.id, current.id));
    await f.end();
    await expectFullSave(f);
  });

  async function failBeforeProviderTurn(f: Awaited<ReturnType<typeof preparedFollowUp>>, options: { proof: boolean }) {
    const agentId = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runB)))[0]!.agentId;
    await db.insert(heartbeatRunEvents).values([
      { companyId: f.companyId, runId: f.runB, agentId, seq: 10, stream: "system", level: "info", eventType: "native.process_start_requested" },
      { companyId: f.companyId, runId: f.runB, agentId, seq: 11, stream: "system", level: "info", eventType: "session.started",
        sourceInstanceId: "runner-b", sourceEventId: "runner-b:1", sourceSeq: 1 },
    ]);
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runB));
    await db.insert(nativeRunnerCheckpoints).values({ companyId: f.companyId, runId: f.runB, issueId: f.issueId,
      part: "command:session.open", material: { type: "session.open", status: "completed" } });
    if (options.proof) await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({
      [FAILED_BEFORE_PROVIDER_TURN_KEY]: { schema: FAILED_BEFORE_PROVIDER_TURN_SCHEMA, cause: "native_failed_before_provider_turn",
        proof: { source: "runner_ledger", noProviderTurn: true, provenAt: new Date().toISOString() } } })}::jsonb` })
      .where(eq(heartbeatRuns.id, f.runB));
    await f.end({ status: "failed", errorCode: "adapter_failed", processPid: 41_003, processStartedAt: new Date(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
  }

  async function markForReplacement(f: Awaited<ReturnType<typeof preparedFollowUp>>) {
    await db.update(environmentLeases).set({ status: "released", executionWorkspaceId: (await f.workspace()).id,
      leasePolicy: "reuse_by_environment", metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [REPLACE_BEFORE_REUSE_KEY]: { schema: REPLACE_BEFORE_REUSE_SCHEMA, runId: f.runB, predecessorRunId: null,
          recordedAt: new Date().toISOString() } })}::jsonb` }).where(eq(environmentLeases.id, f.leaseB.id));
  }

  async function nextAcquisitionReplaces(f: Awaited<ReturnType<typeof preparedFollowUp>>, runC: string) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseB.id));
    const replace = readReplaceBeforeReuseMarker(lease!.metadata) !== null && await reusableSandboxReplacementPlan({ db,
      lease: lease as EnvironmentLease, companyId: f.companyId, heartbeatRunId: runC,
      executionWorkspaceId: lease!.executionWorkspaceId, adapterType: null,
      cause: new Error("native_predecessor_retirement_unproven") }) === "retire";
    if (replace) await retireReplacedReusableSandboxLease({ db, lease: lease as EnvironmentLease, companyId: f.companyId, heartbeatRunId: runC });
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseB.id)))[0]!;
  }

  async function sweepCleanup() {
    const calls: string[] = [];
    const runtime = new Proxy({}, { get: (_target, name) => typeof name === "string" && name !== "then"
      ? async () => { calls.push(name); return name === "isPendingCleanupWorkerReady" ? true : { destroyed: true }; } : undefined });
    await heartbeatService(db, { environmentRuntime: runtime as never }).sweepPendingCleanupLeases({ backoffMs: 0 });
    return calls;
  }

  it("hands on the workspace unchanged when the Runner ledger proves the failed run sent no provider turn", async () => {
    const f = await preparedFollowUp();
    await failBeforeProviderTurn(f, { proof: true });
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId })).toBeTruthy();
    const workspace = await f.workspace();
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toMatchObject({ dirty: false, writerRunId: null,
      snapshotId: f.savedA.snapshotId, epoch: 2 });
    expect(workspace.metadata?.[UNCHANGED_BASELINE_KEY]).toMatchObject({ runId: f.runB, releasedAt: expect.any(String) });
    expect(workspace.metadata?.remoteWorkspaceAbandonedEpochs).toBeUndefined();
  });

  it("replaces the marked sandbox when the failed run provably left its files unchanged", async () => {
    const f = await preparedFollowUp();
    await failBeforeProviderTurn(f, { proof: true });
    await markForReplacement(f);
    const released = await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId });
    const { runC } = await f.reserveNext();
    expect(await nextAcquisitionReplaces(f, runC)).toMatchObject({ status: "pending_cleanup" });
    expect(released).toBe(true);
    expect(await sweepCleanup()).toEqual(expect.arrayContaining(["destroyRunLease"]));
  });

  it("keeps today's preservation for the same evidence without the Runner ledger proof", async () => {
    const f = await preparedFollowUp();
    await failBeforeProviderTurn(f, { proof: false });
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId })).toBe(false);
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ dirty: true, writerRunId: f.runB });
  });

  it.each([
    { label: "a provider turn was recorded", setup: async (f: Awaited<ReturnType<typeof preparedFollowUp>>) => { await f.event("turn.started"); } },
    { label: "a predecessor's save on this sandbox is unsettled", setup: async (f: Awaited<ReturnType<typeof preparedFollowUp>>) => {
      await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: (await f.workspace()).id,
        heartbeatRunId: f.runA, phase: "remote_workspace_snapshot", status: "running" });
    } },
    { label: "setup wrote into the workspace", provision: "echo provisioned > provisioned.txt",
      setup: async () => undefined },
  ])("never claims unchanged when $label: continues from the last committed save and keeps the files unapplied", async ({ setup, provision }) => {
    const f = await preparedFollowUp(provision ? { runtimeProvisionCommand: provision } : {});
    await writeFile(path.join(f.remoteRoot, "unsaved.md"), "kept\n");
    await setup(f);
    await failBeforeProviderTurn(f, { proof: true });
    expect(await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId })).toBeTruthy();
    const workspace = await f.workspace();
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toMatchObject({ dirty: false, writerRunId: null, location: null,
      snapshotId: f.savedA.snapshotId, epoch: 3 });
    expect(workspace.metadata?.[UNCHANGED_BASELINE_KEY]).not.toHaveProperty("releasedAt");
    expect(workspace.metadata?.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 2, runId: f.runB,
      snapshotId: f.savedA.snapshotId, location: expect.objectContaining({ remoteCwd: f.remoteRoot }) })]);
    await expect(access(path.join(f.remoteRoot, "unsaved.md"))).resolves.toBeUndefined();
    const { runC } = await f.reserveNext();
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ writerRunId: runC, location: null });
  });

  it("continues on a fresh sandbox and parks the one that holds abandoned files, which cleanup leaves alone", async () => {
    const f = await preparedFollowUp({ runtimeProvisionCommand: "echo provisioned > provisioned.txt" });
    await writeFile(path.join(f.remoteRoot, "unsaved.md"), "kept\n");
    await failBeforeProviderTurn(f, { proof: true });
    await markForReplacement(f);
    const released = await releaseUnchangedFallbackWorkspace(db, { id: f.runB, companyId: f.companyId });
    const { runC } = await f.reserveNext();
    expect(released).toBe(true);
    const lease = await nextAcquisitionReplaces(f, runC);
    expect(lease).toMatchObject({ status: "retained", failureReason: ABANDONED_WORKSPACE_FILES_PARKED_REASON });
    expect(lease.metadata).toHaveProperty(REPLACE_BEFORE_REUSE_KEY);
    expect(await abandonedWorkspaceFilesHeldOnLease(db, lease)).toBe(true);
    expect(await sweepCleanup()).not.toEqual(expect.arrayContaining(["destroyRunLease"]));
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseB.id)))
      .toEqual([expect.objectContaining({ status: "retained" })]);
    await expect(access(path.join(f.remoteRoot, "unsaved.md"))).resolves.toBeUndefined();
  });
});
