import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { offlineMigrationExecutionWhere } from "../offline-migration-execution.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { hasNativeRunnerCheckpoint, loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { importNativeControllerRecovery, readNativeControllerRecovery } from "./native-controller-recovery.js";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";
import { providerPackWorkspaceId, resolveRemoteProviderPackAuthority } from "./remote-provider-pack-authority.js";
import { nativeSha256 } from "./canonical.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import type { StorageService } from "../../storage/types.js";
import { durableNativeHarnessStorage } from "./native-harness-backup-storage.js";
import { archiveFailedLegacyNativeController, hasArchivedLegacyNativeController } from "./native-controller-archive.js";

type Selected = { id: string; companyId: string; agentId: string; issueId: string; sessionId: string; createdAt: Date };

async function* retainedSources(db: Db, signal?: AbortSignal) {
  let after: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const rows = await db.execute<Selected>(sql`select s.id, s.company_id as "companyId", s.agent_id as "agentId",
      r.native_issue_id as "issueId", r.native_session_id as "sessionId", r.created_at as "createdAt"
      from agent_task_sessions s join heartbeat_runs r on r.id = s.last_run_id
        and r.company_id = s.company_id and r.agent_id = s.agent_id
      where s.adapter_type = 'paperclip_runner' and r.native_issue_id is not null and r.native_session_id is not null
        ${after ? sql`and s.id > ${after}::uuid` : sql``} order by s.id limit 100`);
    for (const selected of rows) {
      signal?.throwIfAborted();
      const source = await findNativeSessionResumeRun(db, { companyId: selected.companyId, agentId: selected.agentId,
        issueId: selected.issueId, normalizedSessionId: selected.sessionId,
        beforeCreatedAt: new Date(selected.createdAt), includeProgressBarrier: true });
      if (source) yield { selected, source };
    }
    if (rows.length < 100) return;
    after = rows.at(-1)!.id;
  }
}

async function readPrivateSource(file: string, maxBytes: number): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; throw error;
  });
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("native_controller_migration_unsafe_source");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function localPaths(source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>) {
  const execution = parseNativeExecutionInput(source.runnerProfileJson.nativeExecutionInput);
  const descriptor = nativeControllerMigrationDescriptor(execution, source.runnerProfileJson.nativeToolContractFingerprint);
  const root = await lstat(descriptor.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; throw error;
  });
  if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error("native_controller_migration_unsafe_source");
  const control = join(descriptor.root, "control-plane");
  const directory = await lstat(control).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; throw error;
  });
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error("native_controller_migration_unsafe_source");
  return { ...descriptor, execution, controlFile: join(control, "control-plane-state.json") };
}

function preservedFailedCheckpoint(source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  sessionId: string, checkpoint: Awaited<ReturnType<typeof loadNativeRunnerCheckpoint>>) {
  return source.status === "failed" && source.runnerProfileJson.sessionCheckpoint == null
    && checkpoint?.runId === source.id && checkpoint.recoveryEvidence.runnerInstanceId === source.runnerInstanceId
    && checkpoint.recoveryEvidence.normalizedSessionId === sessionId;
}

export async function hasLocalNativeControllerObligations(db: Db, storage?: StorageService | null): Promise<boolean> {
  const roots = await readdir(nativeHarnessStateBase()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]; throw error;
  });
  if (!roots.length) return false;
  for await (const { selected, source } of retainedSources(db)) {
    const binding = { companyId: selected.companyId, issueId: selected.issueId, runId: source.id };
    if (readNativeControllerRecovery(source.runnerProfileJson.nativeControllerRecovery, source.runnerProfileJson.sessionCheckpoint)
      && await hasNativeRunnerCheckpoint(db, binding)) continue;
    if (source.status === "failed" && source.runnerProfileJson.sessionCheckpoint == null
      && preservedFailedCheckpoint(source, selected.sessionId, await loadNativeRunnerCheckpoint(db, binding))) continue;
    const paths = await localPaths(source);
    const present = await lstat(paths.controlFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (present && source.status === "failed") {
      const archiveStorage = storage === undefined ? durableNativeHarnessStorage() : storage;
      const controller = await readPrivateSource(paths.controlFile, 256 * 1024 * 1024);
      const supervisor = paths.execution.session.lifecyclePolicy.mode === "warm"
        ? await readPrivateSource(paths.supervisorPath, 4 * 1024 * 1024) : undefined;
      if (controller !== undefined && archiveStorage && await hasArchivedLegacyNativeController(db, { ...binding, storage: archiveStorage, controller, supervisor })) continue;
    }
    if (present || await hasNativeRunnerCheckpoint(db, binding)) return true;
  }
  return false;
}

export async function migrateNativeControllers(db: Db, input: { writersStopped: true; signal: AbortSignal; storage?: StorageService }) {
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(offlineMigrationExecutionWhere()).limit(1);
  if (!input.writersStopped || active) throw new Error("native_controller_migration_requires_offline_writers");
  const counts = { inspected: 0, imported: 0, unchanged: 0, sourceAlreadyAbsent: 0, archivedFailed: 0, preservedFailed: 0 };
  for await (const { selected, source } of retainedSources(db, input.signal)) {
    counts.inspected++;
    const binding = { companyId: selected.companyId, issueId: selected.issueId, runId: source.id };
    const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
    if (preservedFailedCheckpoint(source, selected.sessionId, checkpoint)) { counts.preservedFailed++; continue; }
    const metadata = readNativeControllerRecovery(source.runnerProfileJson.nativeControllerRecovery, source.runnerProfileJson.sessionCheckpoint);
    const snapshot = source.runnerProfileJson.sessionCheckpoint as { identity?: Record<string, unknown> } | null;
    if (checkpoint && metadata?.checkpoint?.runId === source.id
      && metadata.checkpoint.runnerInstanceId === source.runnerInstanceId
      && metadata.checkpoint.normalizedSessionId === selected.sessionId
      && snapshot?.identity?.runId === source.id && snapshot.identity.companyId === selected.companyId
      && snapshot.identity.agentId === selected.agentId && snapshot.identity.issueId === selected.issueId
      && snapshot.identity.sessionId === selected.sessionId
      && checkpoint.recoveryEvidence.runnerInstanceId === source.runnerInstanceId
      && checkpoint.recoveryEvidence.normalizedSessionId === selected.sessionId) { counts.unchanged++; continue; }
    const paths = await localPaths(source);
    const legacyControllerState = checkpoint ? undefined : await readPrivateSource(paths.controlFile, 256 * 1024 * 1024);
    if (!checkpoint && legacyControllerState === undefined) { counts.sourceAlreadyAbsent++; continue; }
    let legacyRunnerArtifact: { version: string; digest: string } | undefined;
    if (legacyControllerState !== undefined && await readPrivateSource(join(paths.root, "provider-pack-authority.json"), 512 * 1024)) {
      const identity = JSON.parse(legacyControllerState).identity;
      const execution = paths.execution;
      const [admission] = await db.select({ workspace: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'` })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, selected.companyId),
          eq(heartbeatRuns.agentId, selected.agentId)));
      const workspace = readNativeWorkspaceSyncReference(admission?.workspace);
      const remoteCwd = workspace?.remoteCwd ?? execution.workspace.cwd;
      if (typeof identity?.environmentLeaseId !== "string" || !remoteCwd
        || (workspace && workspace.workspaceId !== execution.binding.executionWorkspaceId)) {
        throw new Error("native_controller_migration_artifact_binding");
      }
      const unavailable = (): never => { throw new Error("native_controller_migration_artifact_unavailable"); };
      legacyRunnerArtifact = resolveRemoteProviderPackAuthority({ stateDirectory: paths.root, reattach: true,
        binding: { companyId: selected.companyId, agentId: selected.agentId,
          workspaceId: providerPackWorkspaceId(execution.binding.executionWorkspaceId, source.id, identity.environmentLeaseId),
          sessionId: selected.sessionId, runnerInstanceId: source.runnerInstanceId!,
          environmentLeaseId: identity.environmentLeaseId, remoteCwd,
          providerDigest: nativeSha256(execution.provider) },
        current: unavailable, runnerArtifact: unavailable }).runnerArtifact;
    }
    const supervisor = paths.execution.session.lifecyclePolicy.mode === "warm"
      ? await readPrivateSource(paths.supervisorPath, 4 * 1024 * 1024) : undefined;
    input.signal.throwIfAborted();
    let result: Awaited<ReturnType<typeof importNativeControllerRecovery>>;
    try {
      result = await importNativeControllerRecovery(db, { ...binding, agentId: selected.agentId,
        normalizedSessionId: selected.sessionId, expectedConfigDigest: paths.configDigest,
        supervisor: supervisor === undefined ? undefined : JSON.parse(supervisor),
        offline: { writersStopped: true, legacyControllerState, legacyRunnerArtifact } });
    } catch (error) {
      const storage = input.storage ?? durableNativeHarnessStorage();
      if (!(error instanceof Error) || error.message !== "native_runner_checkpoint_artifact_unproven"
        || source.status !== "failed" || legacyControllerState === undefined || !storage) throw error;
      await archiveFailedLegacyNativeController(db, { ...binding, storage, controller: legacyControllerState, supervisor,
        writersStopped: true, signal: input.signal });
      counts.archivedFailed++;
      continue;
    }
    if (result.kind !== "imported" && result.kind !== "unchanged") {
      throw new Error(`native_controller_migration_blocked:${source.id}:${"reason" in result ? result.reason : result.kind}`);
    }
    counts[result.kind]++;
  }
  return counts;
}
