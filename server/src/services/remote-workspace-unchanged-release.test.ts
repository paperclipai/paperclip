import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, closeRegisteredClients, companies, createDb, environmentLeases, environments, executionWorkspaces,
  heartbeatRunEvents, heartbeatRuns, issues, workspaceOperations,
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
    return { companyId, runA, runB, savedA, workspace, end, saveB, snapshotOperations, reserveNext, parkWaiter, event,
      captures: () => captures };
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
});
