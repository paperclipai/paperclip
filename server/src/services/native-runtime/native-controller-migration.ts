import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, inspectDurablePrpCheckpointHeader, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
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
import { redactRunnerApiPayloads } from "./runner-api-log-redaction.js";
import { archiveSettledFailedNativeController } from "./native-controller-archive-source.js";
import { nativeControllerSourceDigest } from "./native-controller-source-digest.js";

type Selected = { id: string; companyId: string; agentId: string; issueId: string; sessionId: string; createdAt: Date; lastRunId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function confirmedOlderSuccessfulSnapshot(db: Db, selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  paths: Awaited<ReturnType<typeof localPaths>>, olderRunId: unknown) {
  const snapshot = record(source.runnerProfileJson.sessionCheckpoint), identity = record(snapshot.identity);
  const scope = { companyId: selected.companyId, agentId: selected.agentId, issueId: selected.issueId, sessionId: selected.sessionId };
  if (source.status !== "failed" || identity.runId !== source.id
    || Object.entries(scope).some(([key, value]) => identity[key] !== value)
    || paths.execution.binding.runId !== source.id || paths.execution.binding.companyId !== selected.companyId
    || paths.execution.binding.agentId !== selected.agentId || paths.execution.binding.issueId !== selected.issueId
    || paths.execution.session.normalizedSessionId !== selected.sessionId
    || typeof snapshot.sessionId !== "string" || !snapshot.sessionId.trim()
    || typeof olderRunId !== "string" || olderRunId === source.id
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(olderRunId)) return null;
  const [prior] = await db.select({ createdAt: heartbeatRuns.createdAt, finishedAt: heartbeatRuns.finishedAt,
    runnerInstanceId: heartbeatRuns.runnerInstanceId, snapshot: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, olderRunId), eq(heartbeatRuns.companyId, selected.companyId),
      eq(heartbeatRuns.agentId, selected.agentId), eq(heartbeatRuns.nativeIssueId, selected.issueId),
      eq(heartbeatRuns.nativeSessionId, selected.sessionId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "succeeded")));
  const priorSnapshot = record(prior?.snapshot), priorIdentity = record(priorSnapshot.identity);
  if (!prior?.finishedAt || prior.createdAt >= source.createdAt
    || !source.runnerInstanceId || prior.runnerInstanceId !== source.runnerInstanceId
    || priorIdentity.runId !== olderRunId || Object.entries(scope).some(([key, value]) => priorIdentity[key] !== value)
    || priorSnapshot.sessionId !== snapshot.sessionId || priorSnapshot.backendKind !== snapshot.backendKind) return null;
  const [failed] = await db.select({ finishedAt: heartbeatRuns.finishedAt, startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, selected.companyId), eq(heartbeatRuns.agentId, selected.agentId),
    eq(heartbeatRuns.nativeIssueId, selected.issueId), eq(heartbeatRuns.nativeSessionId, selected.sessionId),
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed")));
  return failed?.finishedAt && prior.finishedAt <= (failed.startedAt ?? source.createdAt) ? priorSnapshot : null;
}

async function hasConfirmedOlderSupervisor(db: Db, selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  paths: Awaited<ReturnType<typeof localPaths>>, supervisor: unknown) {
  const olderSnapshot = record(record(supervisor).snapshot);
  const prior = await confirmedOlderSuccessfulSnapshot(db, selected, source, paths, record(olderSnapshot.identity).runId);
  return prior !== null && nativeSha256(prior) === nativeSha256(redactRunnerApiPayloads(olderSnapshot));
}

async function hasConfirmedOlderController(db: Db, selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  paths: Awaited<ReturnType<typeof localPaths>>, controller: string, artifact?: { version: string; digest: string }) {
  const identity = record(record(JSON.parse(controller)).identity);
  if (!await confirmedOlderSuccessfulSnapshot(db, selected, source, paths, identity.runId)) return false;
  try {
    captureLegacyDurablePrpCheckpoint(controller, { runId: String(identity.runId),
      runnerInstanceId: source.runnerInstanceId!, normalizedSessionId: selected.sessionId }, artifact);
    return true;
  } catch { return false; }
}

async function* retainedSources(db: Db, signal?: AbortSignal) {
  let after: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const rows = await db.execute<Selected>(sql`select s.id, s.company_id as "companyId", s.agent_id as "agentId",
      r.native_issue_id as "issueId", r.native_session_id as "sessionId", r.created_at as "createdAt", r.id as "lastRunId"
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
  if (execution.binding.companyId !== source.companyId || execution.binding.agentId !== source.agentId
    || execution.binding.issueId !== source.nativeIssueId || execution.binding.runId !== source.id
    || execution.session.normalizedSessionId !== source.nativeSessionId) throw new Error("native_controller_migration_artifact_binding");
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

export async function readLegacyNativeControllerArchiveSource(source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>) {
  const paths = await localPaths(source);
  const controller = await readPrivateSource(paths.controlFile, 256 * 1024 * 1024);
  const supervisor = paths.execution.session.lifecyclePolicy.mode === "warm"
    ? await readPrivateSource(paths.supervisorPath, 4 * 1024 * 1024) : undefined;
  return { paths, controller, supervisor };
}

export async function readLegacyNativeControllerArchiveDigests(source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>) {
  const paths = await localPaths(source);
  return { controllerDigest: await nativeControllerSourceDigest(paths.controlFile, 256 * 1024 * 1024),
    supervisorDigest: paths.execution.session.lifecyclePolicy.mode === "warm"
      ? await nativeControllerSourceDigest(paths.supervisorPath, 4 * 1024 * 1024) : undefined };
}

function preservedFailedCheckpoint(source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  sessionId: string, checkpoint: Awaited<ReturnType<typeof loadNativeRunnerCheckpoint>>) {
  return source.status === "failed" && source.runnerProfileJson.sessionCheckpoint == null
    && checkpoint?.runId === source.id && checkpoint.recoveryEvidence.runnerInstanceId === source.runnerInstanceId
    && checkpoint.recoveryEvidence.normalizedSessionId === sessionId;
}

async function preservedDatabaseOnlyFailedCheckpoint(selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  checkpoint: Awaited<ReturnType<typeof loadNativeRunnerCheckpoint>>) {
  const snapshot = record(source.runnerProfileJson.sessionCheckpoint), identity = record(snapshot.identity);
  if (source.status !== "failed" || source.runtimeMode !== "native" || !checkpoint
    || source.companyId !== selected.companyId || source.agentId !== selected.agentId
    || source.nativeIssueId !== selected.issueId || source.nativeSessionId !== selected.sessionId
    || identity.companyId !== selected.companyId || identity.agentId !== selected.agentId
    || identity.issueId !== selected.issueId || identity.runId !== source.id || identity.sessionId !== selected.sessionId
    || typeof snapshot.sessionId !== "string" || !snapshot.sessionId.trim()
    || checkpoint.runId !== source.id || checkpoint.recoveryEvidence.runnerInstanceId !== source.runnerInstanceId
    || checkpoint.recoveryEvidence.normalizedSessionId !== selected.sessionId) return false;
  const header = inspectDurablePrpCheckpointHeader(checkpoint.records.get("header") ?? "");
  if (header?.runId !== source.id || header.runnerInstanceId !== source.runnerInstanceId
    || header.normalizedSessionId !== selected.sessionId) return false;
  const paths = await localPaths(source);
  for (const file of [paths.controlFile, paths.supervisorPath]) {
    const present = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (present) return false;
  }
  return true;
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
    if (!present && source.status === "failed" && source.runnerProfileJson.sessionCheckpoint != null
      && await preservedDatabaseOnlyFailedCheckpoint(selected, source, await loadNativeRunnerCheckpoint(db, binding))) continue;
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

function hasMatchingControllerRecovery(selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  checkpoint: Awaited<ReturnType<typeof loadNativeRunnerCheckpoint>>) {
  const metadata = readNativeControllerRecovery(source.runnerProfileJson.nativeControllerRecovery, source.runnerProfileJson.sessionCheckpoint);
  const snapshot = source.runnerProfileJson.sessionCheckpoint as { identity?: Record<string, unknown> } | null;
  return Boolean(checkpoint && metadata?.checkpoint?.runId === source.id
      && metadata.checkpoint.runnerInstanceId === source.runnerInstanceId
      && metadata.checkpoint.normalizedSessionId === selected.sessionId
      && snapshot?.identity?.runId === source.id && snapshot.identity.companyId === selected.companyId
      && snapshot.identity.agentId === selected.agentId && snapshot.identity.issueId === selected.issueId
      && snapshot.identity.sessionId === selected.sessionId
      && checkpoint.recoveryEvidence.runnerInstanceId === source.runnerInstanceId
      && checkpoint.recoveryEvidence.normalizedSessionId === selected.sessionId);
}

async function readMigrationMaterial(db: Db, selected: Selected,
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>,
  checkpoint: Awaited<ReturnType<typeof loadNativeRunnerCheckpoint>>) {
  const paths = await localPaths(source);
  const legacyControllerState = checkpoint ? undefined : await readPrivateSource(paths.controlFile, 256 * 1024 * 1024);
  let legacyRunnerArtifact: { version: string; digest: string } | undefined;
  if (!checkpoint && legacyControllerState === undefined) return { paths, legacyControllerState, legacyRunnerArtifact, supervisor: undefined };
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
  const supervisor = !checkpoint && paths.execution.session.lifecyclePolicy.mode === "warm"
    ? await readPrivateSource(paths.supervisorPath, 4 * 1024 * 1024) : undefined;
  return { paths, legacyControllerState, legacyRunnerArtifact, supervisor };
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
    if (await preservedDatabaseOnlyFailedCheckpoint(selected, source, checkpoint)) { counts.preservedFailed++; continue; }
    if (hasMatchingControllerRecovery(selected, source, checkpoint)) { counts.unchanged++; continue; }
    const { paths, legacyControllerState, legacyRunnerArtifact, supervisor } = await readMigrationMaterial(db, selected, source, checkpoint);
    if (!checkpoint && legacyControllerState === undefined) { counts.sourceAlreadyAbsent++; continue; }
    input.signal.throwIfAborted();
    let result: Awaited<ReturnType<typeof importNativeControllerRecovery>>;
    try {
      result = await importNativeControllerRecovery(db, { ...binding, agentId: selected.agentId,
        normalizedSessionId: selected.sessionId, expectedConfigDigest: paths.configDigest,
        supervisor: supervisor === undefined ? undefined : JSON.parse(supervisor),
        offline: { writersStopped: true, legacyControllerState, legacyRunnerArtifact } });
    } catch (error) {
      const storage = input.storage ?? durableNativeHarnessStorage();
      if (!(error instanceof Error) || source.status !== "failed" || legacyControllerState === undefined || !storage) throw error;
      const archivable = error.message === "native_runner_checkpoint_artifact_unproven"
        || error.message === "native_runner_checkpoint_binding_mismatch"
          && await hasConfirmedOlderController(db, selected, source, paths, legacyControllerState, legacyRunnerArtifact);
      if (!archivable) throw error;
      await archiveFailedLegacyNativeController(db, { ...binding, storage, controller: legacyControllerState, supervisor,
        writersStopped: true, signal: input.signal });
      counts.archivedFailed++;
      continue;
    }
    if (result.kind !== "imported" && result.kind !== "unchanged") {
      if (result.kind === "missing_evidence" && result.reason === "stale_supervisor_snapshot"
        && legacyControllerState !== undefined && supervisor !== undefined
        && await hasConfirmedOlderSupervisor(db, selected, source, paths, JSON.parse(supervisor))) {
        const storage = input.storage ?? durableNativeHarnessStorage();
        if (storage) {
          await archiveFailedLegacyNativeController(db, { ...binding, storage, controller: legacyControllerState, supervisor,
            writersStopped: true, signal: input.signal });
          counts.archivedFailed++;
          continue;
        }
      }
      throw new Error(`native_controller_migration_blocked:${source.id}:${"reason" in result ? result.reason : result.kind}`);
    }
    counts[result.kind]++;
  }
  return counts;
}

function onlineControllerSourceDeferral(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const reasons: Record<string, string> = {
    native_runner_checkpoint_artifact_unproven: "artifact_unproven",
    native_runner_checkpoint_binding_mismatch: "checkpoint_binding",
    native_controller_migration_source_changed: "source_changed",
    native_controller_migration_unsafe_source: "unsafe_source",
    native_controller_migration_artifact_binding: "artifact_binding",
    native_controller_migration_artifact_unavailable: "artifact_unavailable",
    native_controller_archive_source_unsettled: "archive_source_unsettled",
  };
  if (reasons[error.message]) return reasons[error.message];
  if (error.message.startsWith("runner_remote_provider_artifact_incompatible:")) return "artifact_incompatible";
  if (error instanceof SyntaxError) return "invalid_source_json";
  if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return "source_unavailable";
  return null;
}

export async function prestageNativeControllers(db: Db, input: { signal: AbortSignal; storage?: StorageService }) {
  const counts = { inspected: 0, imported: 0, unchanged: 0, archivedFailed: 0, sourceAlreadyAbsent: 0, deferred: {} as Record<string, number> };
  const defer = (reason: string) => { counts.deferred[reason] = (counts.deferred[reason] ?? 0) + 1; };
  for await (const { selected, source } of retainedSources(db, input.signal)) {
    counts.inspected++;
    input.signal.throwIfAborted();
    let outcome = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, selected.companyId),
        eq(issues.id, selected.issueId))).for("update");
      if (!task || task.executionRunId || task.checkoutRunId) return "source_active";
      const [owner] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, selected.companyId), eq(nativeRunFinalizations.issueId, selected.issueId),
        eq(nativeRunFinalizations.runId, source.id))).for("update");
      if (!owner || owner.leaseOwner || owner.phase !== "committed" || !owner.resultId || owner.recoveryState) return "owner_not_released";
      const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, source.id),
        eq(heartbeatRuns.companyId, selected.companyId), eq(heartbeatRuns.agentId, selected.agentId),
        eq(heartbeatRuns.nativeIssueId, selected.issueId), eq(heartbeatRuns.nativeSessionId, selected.sessionId))).for("update");
      if (!current || !["succeeded", "failed"].includes(current.status) || !current.finishedAt) return "source_not_successful";
      const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, selected.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
        or(eq(heartbeatRuns.nativeIssueId, selected.issueId), eq(heartbeatRuns.issueId, selected.issueId),
          eq(heartbeatRuns.nativeSessionId, selected.sessionId)))).limit(1);
      if (active) return "source_active";
      const scoped = tx as unknown as Db;
      const binding = { companyId: selected.companyId, issueId: selected.issueId, runId: source.id };
      const checkpoint = await loadNativeRunnerCheckpoint(scoped, binding);
      const profile = record(current.runnerProfileJson);
      const freshSource = { ...source, status: current.status, runnerInstanceId: current.runnerInstanceId,
        runnerProfileJson: { nativeToolContractFingerprint: profile.nativeToolContractFingerprint,
          nativeExecutionInput: profile.nativeExecutionInput, sessionCheckpoint: profile.sessionCheckpoint,
          nativeControllerRecovery: profile.nativeControllerRecovery } };
      if (hasMatchingControllerRecovery(selected, freshSource, checkpoint)) return "unchanged";
      const material = await readMigrationMaterial(scoped, selected, freshSource, checkpoint);
      if (!checkpoint && material.legacyControllerState === undefined) return "source_already_absent";
      input.signal.throwIfAborted();
      const result = await importNativeControllerRecovery(scoped, { ...binding, agentId: selected.agentId,
        normalizedSessionId: selected.sessionId, expectedConfigDigest: material.paths.configDigest,
        supervisor: material.supervisor === undefined ? undefined : JSON.parse(material.supervisor),
        legacyCheckpoint: { legacyControllerState: material.legacyControllerState,
          legacyRunnerArtifact: material.legacyRunnerArtifact } });
      if (result.kind !== "imported" && result.kind !== "unchanged") return "source_unproven";
      if (material.legacyControllerState !== undefined
        && await readPrivateSource(material.paths.controlFile, 256 * 1024 * 1024) !== material.legacyControllerState) {
        throw new Error("native_controller_migration_source_changed");
      }
      if (material.supervisor !== undefined
        && await readPrivateSource(material.paths.supervisorPath, 4 * 1024 * 1024) !== material.supervisor) {
        throw new Error("native_controller_migration_source_changed");
      }
      input.signal.throwIfAborted();
      return result.kind;
    }).catch(error => {
      input.signal.throwIfAborted();
      const reason = onlineControllerSourceDeferral(error);
      if (reason) return reason;
      if (error?.code === "55P03" || error?.cause?.code === "55P03") return "source_busy";
      throw error;
    });
    if (source.status === "failed" && ["owner_not_released", "artifact_unproven", "checkpoint_binding", "source_unproven", "artifact_binding"].includes(outcome)) {
      const storage = input.storage ?? durableNativeHarnessStorage();
      if (storage) outcome = await archiveSettledFailedNativeController(db, { selected, source, storage, signal: input.signal }).catch(error => {
        input.signal.throwIfAborted();
        const reason = onlineControllerSourceDeferral(error);
        if (reason) return reason;
        if (error?.code === "55P03" || error?.cause?.code === "55P03") return "source_busy";
        throw error;
      });
    }
    if (outcome === "archived_failed") counts.archivedFailed++;
    else if (outcome === "imported" || outcome === "unchanged") counts[outcome]++;
    else if (outcome === "source_already_absent") counts.sourceAlreadyAbsent++;
    else defer(outcome);
  }
  return counts;
}
