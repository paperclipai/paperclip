import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, posix } from "node:path";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { agentTaskSessions, companySkillRepositorySnapshots, companySkillVersions, environmentLeases,
  heartbeatRuns, issues, nativeHarnessBackups, nativeRunnerCheckpoints, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "../remote-execution-termination.js";
import { verifyFileManifest, type FileManifestEntry } from "../file-manifest-cache.js";
import { skillPackageStore } from "../skill-package-store.js";
import { skillPackageManifest } from "../skill-package-files.js";
import { assertSkillSnapshotPath, skillFileBytes } from "../skill-snapshot.js";
import { REPOSITORY_CONTENT_DIR, repositorySkillProjection } from "../skill-repository-package.js";
import { captureLegacyDurablePrpCheckpoint, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { readRuntimeSkillPreservation } from "./runtime-skill-preservation-reference.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { resolveNativeHarnessPersistenceProfile, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { readNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import { assertOriginalHarnessVolumeSource, type OriginalHarnessVolumeCapability } from "./native-harness-original-volume.js";
import { isKnownNativeSessionRootEntry } from "./native-session-root-entries.js";
import { readLegacyNativeControllerArchiveSource, readLegacyNativeControllerArchiveDigests } from "./native-controller-migration.js";
import { archiveNativeControllerSourceEvidence, legacyNativeControllerArchive } from "./native-controller-archive.js";
import { nativeControllerArchiveCoordinatorDigest, nativeControllerArchiveProfileDigest, type SettledControllerArchiveOwner } from "./native-controller-archive-source.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { readNativeControllerRecovery } from "./native-controller-recovery.js";
import { verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";

const KEY = "nativeHarnessFilesystemIndependence";
const SCHEMA = "paperclip.native-harness-filesystem-independence.v1";
const terminal = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => nativeSha256(JSON.parse(JSON.stringify(value)));
function fail(): never { throw new Error("native_harness_filesystem_independence_unverified"); }
const profile = (value: Record<string, unknown> | null) => { const copy = { ...value }; delete copy[KEY]; return copy; };
type PackageBinding = { id: string; digest: string };
type VersionBinding = { id: string; digest: string };
type ControllerBinding = { checkpointPartsDigest: string; archive: null | { id: string; digest: string;
  controllerDigest: string; supervisorDigest: string | null } };
type Receipt = { schema: typeof SCHEMA; selectedSessionId: string; lastRunId: string; sourceRunId: string; scopeDigest: string;
  factsDigest: string; sourceCapabilityFingerprint: string; localFactsDigest: string; assetsDigest: string;
  packages: PackageBinding[]; versions: VersionBinding[]; controller: ControllerBinding; observedAt: string };
type Scope = { companyId: string; selectedSessionId: string; scopeDigest: string };
type Run = typeof heartbeatRuns.$inferSelect;
const evidenceOwners = new WeakMap<SettledControllerArchiveOwner, { scope: Scope; factsDigest: string }>();

async function databaseFacts(db: Db, input: Scope, lock: boolean) {
  const [selection] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
    eq(agentTaskSessions.id, input.selectedSessionId), eq(agentTaskSessions.adapterType, "paperclip_runner")));
  if (!selection?.lastRunId || !/^[a-f0-9]{64}$/.test(input.scopeDigest)) fail();
  const [anchor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, selection.agentId), eq(heartbeatRuns.id, selection.lastRunId)));
  if (!anchor?.nativeIssueId || !anchor.nativeSessionId || anchor.runtimeMode !== "native") fail();
  const runsQuery = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, selection.agentId), eq(heartbeatRuns.nativeIssueId, anchor.nativeIssueId),
    eq(heartbeatRuns.nativeSessionId, anchor.nativeSessionId))).orderBy(asc(heartbeatRuns.id)).limit(501);
  const runs = await runsQuery;
  if (!runs.length || runs.length > 500) fail();
  if (lock) for (const run of runs) if (!await tryLockNativeWorkspaceFinalization(db, { companyId: input.companyId, runId: run.id })) fail();
  const ownersQuery = db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    inArray(nativeRunFinalizations.runId, runs.map(run => run.id)))).orderBy(asc(nativeRunFinalizations.runId));
  const owners = await (lock ? ownersQuery.for("update") : ownersQuery);
  const taskQuery = db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, anchor.nativeIssueId)));
  const [task] = await (lock ? taskQuery.for("update") : taskQuery);
  if (!task || task.executionRunId || task.checkoutRunId) fail();
  if (lock) {
    const [current] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, selection.id)).for("share");
    if (digest(current) !== digest(selection)) fail();
    const locked = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runs.map(run => run.id))).orderBy(asc(heartbeatRuns.id)).for("share");
    if (digest(locked) !== digest(runs)) fail();
  }
  const [clock] = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  const now = new Date(clock.now);
  for (const run of runs) {
    const owner = owners.find(row => row.runId === run.id);
    if (!terminal.includes(run.status) || !run.finishedAt || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now
      || adapterExecutionControls.has(run.id) || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null
      || !owner || owner.leaseOwner !== null || owner.nextAttemptAt !== null
      || !(owner.phase === "terminal_failure" || owner.phase === "committed" && owner.resultId)) fail();
  }
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    inArray(heartbeatRuns.status, ["queued", "running"]), or(eq(heartbeatRuns.nativeIssueId, anchor.nativeIssueId),
      eq(heartbeatRuns.issueId, anchor.nativeIssueId), eq(heartbeatRuns.nativeSessionId, anchor.nativeSessionId)))).limit(1);
  if (active) fail();
  const source = await findNativeSessionResumeRun(db, { companyId: input.companyId, agentId: anchor.agentId,
    issueId: anchor.nativeIssueId, normalizedSessionId: anchor.nativeSessionId, beforeCreatedAt: anchor.createdAt, includeProgressBarrier: true });
  if (!source) fail();
  const execution = parseNativeExecutionInput(anchor.runnerProfileJson?.nativeExecutionInput);
  const checkpoint = source.runnerProfileJson.sessionCheckpoint as { identity?: Record<string, unknown> } | null;
  if (!["codex", "opencode"].includes(execution.provider.kind) || !("runtimeContext" in execution)
    || execution.binding.companyId !== anchor.companyId || execution.binding.agentId !== anchor.agentId
    || execution.binding.issueId !== anchor.nativeIssueId || execution.binding.runId !== anchor.id
    || execution.session.normalizedSessionId !== anchor.nativeSessionId || basename(scopedRunnerdStateRoot(execution)) !== input.scopeDigest
    || !checkpoint || checkpoint.identity?.runId !== source.id || checkpoint.identity?.companyId !== input.companyId
    || checkpoint.identity?.agentId !== anchor.agentId || checkpoint.identity?.issueId !== anchor.nativeIssueId
    || checkpoint.identity?.sessionId !== anchor.nativeSessionId) fail();
  const leasesQuery = db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    or(inArray(environmentLeases.heartbeatRunId, runs.map(run => run.id)), and(eq(environmentLeases.issueId, anchor.nativeIssueId),
      sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'normalizedSessionId' = ${anchor.nativeSessionId}`))))
    .orderBy(asc(environmentLeases.id));
  const leases = await (lock ? leasesQuery.for("share") : leasesQuery);
  if (!leases.length) fail();
  let matchingStamp = false;
  const terminations = [];
  for (const lease of leases) {
    const resolved = await resolveRemoteTerminationLease(db, lease);
    const receipt = resolved.metadata?.remoteExecutionTermination as { state?: unknown } | undefined;
    if (!hasRemoteTerminationReceipt(resolved) || receipt?.state !== "destroyed") fail();
    terminations.push({ leaseId: lease.id, receipt });
    const stamp = readNativeHarnessBackupStamp(lease.metadata?.nativeHarnessBackup, lease.providerLeaseId ?? "");
    if (stamp?.sessionScopeSha256 === input.scopeDigest && stamp.normalizedSessionId === anchor.nativeSessionId
      && runs.some(run => run.runnerInstanceId === stamp.runnerInstanceId)
      && leases.some(row => row.providerLeaseId === stamp.sourceProviderLeaseId)) matchingStamp = true;
  }
  if (!matchingStamp) fail();
  const factsDigest = digest({ selection, runs: runs.map(run => ({ ...run, runnerProfileJson: profile(run.runnerProfileJson) })), owners,
    task: { id: task.id, executionRunId: task.executionRunId, checkoutRunId: task.checkoutRunId }, leases, terminations,
    sourceRunId: source.id, sourceProfile: source.runnerProfileJson });
  return { anchor, execution, source, factsDigest };
}

async function assetBindings(db: Db, anchor: Run, sourceRunId: string) {
  const preservation = readRuntimeSkillPreservation(anchor);
  const versions: Array<typeof companySkillVersions.$inferSelect> = [], packages = new Map<string, typeof companySkillRepositorySnapshots.$inferSelect>();
  const sources = [anchor];
  if (sourceRunId !== anchor.id) {
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, anchor.companyId), eq(heartbeatRuns.id, sourceRunId)));
    if (!source) fail(); sources.push(source);
  }
  for (const source of sources) {
  const execution = parseNativeExecutionInput(source.runnerProfileJson?.nativeExecutionInput);
  if (!("runtimeContext" in execution) || execution.binding.companyId !== source.companyId
    || execution.binding.agentId !== source.agentId || execution.binding.issueId !== source.nativeIssueId
    || execution.binding.runId !== source.id || execution.session.normalizedSessionId !== source.nativeSessionId) fail();
  const sourcePreservation = readRuntimeSkillPreservation(source);
  for (const skill of execution.runtimeContext.skills) {
    if (skill.versionId) {
      const [version] = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.companyId, anchor.companyId), eq(companySkillVersions.id, skill.versionId)));
      if (!version) fail();
      if (!versions.some(row => row.id === version.id)) versions.push(version);
      const id = version.repositorySnapshotId ?? version.packageSnapshotId;
      if (!id) continue;
      const [row] = await db.select().from(companySkillRepositorySnapshots).where(and(eq(companySkillRepositorySnapshots.companyId, anchor.companyId), eq(companySkillRepositorySnapshots.id, id)));
      if (!row) fail(); packages.set(id, row);
    } else {
      const asset = sourcePreservation?.assets.find(asset => asset.key === skill.key && asset.runtimeName === skill.runtimeName);
      if (!asset) fail();
      runtimeFiles(skill, asset.manifestText);
      const [row] = await db.select().from(companySkillRepositorySnapshots).where(and(eq(companySkillRepositorySnapshots.companyId, anchor.companyId), eq(companySkillRepositorySnapshots.id, asset.packageSnapshotId)));
      if (!row || row.contentHash !== asset.packageContentHash) fail(); packages.set(row.id, row);
    }
  }
  }
  for (const row of packages.values()) if (row.storage?.provider !== "s3" || row.storage.durable !== true) fail();
  return { versions, packages, preservation,
    bindings: { versions: versions.map(row => ({ id: row.id, digest: digest(row) })).sort((a, b) => a.id.localeCompare(b.id)),
      packages: [...packages.values()].map(row => ({ id: row.id, digest: digest({ id: row.id, companyId: row.companyId,
        contentHash: row.contentHash, storage: row.storage }) })).sort((a, b) => a.id.localeCompare(b.id)) } };
}

function matchingReceipt(value: unknown, facts: Awaited<ReturnType<typeof databaseFacts>>, input: Scope,
  bindings: Awaited<ReturnType<typeof assetBindings>>["bindings"], controller: ControllerBinding): Receipt | null {
    const receipt = value as Receipt | undefined;
    if (receipt?.schema !== SCHEMA || receipt.selectedSessionId !== input.selectedSessionId || receipt.scopeDigest !== input.scopeDigest
      || receipt.lastRunId !== facts.anchor.id || receipt.sourceRunId !== facts.source.id || receipt.factsDigest !== facts.factsDigest
      || !/^[a-f0-9]{64}$/.test(receipt.sourceCapabilityFingerprint) || !/^[a-f0-9]{64}$/.test(receipt.localFactsDigest)
      || !Number.isFinite(Date.parse(receipt.observedAt)) || !Array.isArray(receipt.packages) || !Array.isArray(receipt.versions)) return null;
    return digest(bindings) === receipt.assetsDigest && digest(receipt.packages) === digest(bindings.packages)
      && digest(receipt.versions) === digest(bindings.versions) && receipt.controller != null
      && digest(receipt.controller) === digest(controller) ? receipt : null;
}

export async function hasValidNativeHarnessFilesystemIndependence(db: Db, input: Scope): Promise<boolean> {
  try {
    const facts = await databaseFacts(db, input, false);
    const assets = await assetBindings(db, facts.anchor, facts.source.id);
    const existing = facts.anchor.runnerProfileJson?.[KEY] as Receipt | undefined;
    const controller = await controllerBinding(db, facts, existing?.controller?.archive ?? null, false);
    return matchingReceipt(existing, facts, input, assets.bindings, controller) !== null;
  } catch { return false; }
}

export async function assertNativeHarnessFilesystemArchiveSource(db: Db, owner: SettledControllerArchiveOwner) {
  const registered = evidenceOwners.get(owner);
  if (!registered || !owner.filesystemIndependence) fail();
  const facts = await databaseFacts(db, registered.scope, true);
  if (facts.factsDigest !== registered.factsDigest || facts.factsDigest !== owner.filesystemIndependence.factsDigest
    || facts.source.id !== owner.runId || facts.anchor.id !== owner.selectedLastRunId) fail();
}

async function controllerBinding(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>, archive: ControllerBinding["archive"], lock: boolean): Promise<ControllerBinding> {
  const partsQuery = db.select().from(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, facts.anchor.companyId),
    eq(nativeRunnerCheckpoints.issueId, facts.anchor.nativeIssueId!), eq(nativeRunnerCheckpoints.runId, facts.source.id)))
    .orderBy(asc(nativeRunnerCheckpoints.part));
  const parts = await (lock ? partsQuery.for("share") : partsQuery);
  if (archive) {
    if (!parts.some(row => row.part === "header") || !readNativeControllerRecovery(
      facts.source.runnerProfileJson.nativeControllerRecovery, facts.source.runnerProfileJson.sessionCheckpoint)) fail();
    const rowQuery = db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, facts.anchor.companyId),
      eq(nativeHarnessBackups.runId, facts.source.id), eq(nativeHarnessBackups.id, archive.id)));
    const [row] = await (lock ? rowQuery.for("share") : rowQuery);
    if (!row || !["current", "superseded"].includes(row.status) || digest(row) !== archive.digest) fail();
  }
  return { checkpointPartsDigest: digest(parts), archive };
}

async function preserveControllerEvidence(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>, input: Scope & {
  source: OriginalHarnessVolumeCapability; storage: StorageService; signal: AbortSignal;
}): Promise<ControllerBinding> {
  const material = await readLegacyNativeControllerArchiveSource(facts.source);
  if (material.paths.root !== scopedRunnerdStateRoot(facts.execution)) fail();
  if (material.controller === undefined) {
    if (material.supervisor !== undefined) fail();
    return controllerBinding(db, facts, null, false);
  }
  const identity = JSON.parse(material.controller).identity as Record<string, unknown> | undefined;
  if (identity?.runId !== facts.source.id || identity.runnerInstanceId !== facts.source.runnerInstanceId
    || identity.normalizedSessionId !== facts.anchor.nativeSessionId) fail();
  const checkpoint = await loadNativeRunnerCheckpoint(db, { companyId: input.companyId, issueId: facts.anchor.nativeIssueId!, runId: facts.source.id });
  if (!checkpoint || !readNativeControllerRecovery(facts.source.runnerProfileJson.nativeControllerRecovery,
    facts.source.runnerProfileJson.sessionCheckpoint)) fail();
  const captured = captureLegacyDurablePrpCheckpoint(material.controller, { runId: facts.source.id,
    runnerInstanceId: facts.source.runnerInstanceId!, normalizedSessionId: facts.anchor.nativeSessionId! },
    { version: checkpoint.runnerVersion, digest: checkpoint.runnerDigest });
  if (captured.records.size !== checkpoint.records.size || [...captured.records].some(([key, value]) => {
    const durable = checkpoint.records.get(key); return durable === undefined || digest(JSON.parse(value)) !== digest(JSON.parse(durable));
  })) fail();
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.runId, facts.source.id)));
  if (!coordinator) fail();
  const owner: SettledControllerArchiveOwner = Object.freeze({ kind: "settled_controller_archive", companyId: input.companyId,
    issueId: facts.anchor.nativeIssueId!, agentId: facts.anchor.agentId, runId: facts.source.id, sessionId: facts.anchor.nativeSessionId!,
    selectedSessionId: input.selectedSessionId, selectedLastRunId: facts.anchor.id,
    profileDigest: nativeControllerArchiveProfileDigest(facts.source.runnerProfileJson), coordinatorDigest: nativeControllerArchiveCoordinatorDigest(coordinator),
    controllerDigest: sha(material.controller), supervisorDigest: material.supervisor === undefined ? null : sha(material.supervisor),
    filesystemIndependence: Object.freeze({ source: input.source, scopeDigest: input.scopeDigest, factsDigest: facts.factsDigest }) });
  evidenceOwners.set(owner, { scope: { companyId: input.companyId, selectedSessionId: input.selectedSessionId, scopeDigest: input.scopeDigest }, factsDigest: facts.factsDigest });
  const source = { companyId: input.companyId, issueId: facts.anchor.nativeIssueId!, runId: facts.source.id,
    controller: material.controller, supervisor: material.supervisor, purpose: "filesystem_independence" as const };
  await archiveNativeControllerSourceEvidence(db, { ...source, onlineOwner: owner, storage: input.storage, signal: input.signal });
  const descriptor = legacyNativeControllerArchive(source);
  const [row] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, input.companyId),
    eq(nativeHarnessBackups.runId, facts.source.id), eq(nativeHarnessBackups.scopeDigest, descriptor.scopeDigest),
    eq(nativeHarnessBackups.manifestSha256, descriptor.manifestSha256), eq(nativeHarnessBackups.status, "current")));
  if (!row) fail();
  if (!await verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: input.companyId,
    scopeDigest: descriptor.scopeDigest, manifestSha256: descriptor.manifestSha256, backupId: row.id, signal: input.signal })) fail();
  return controllerBinding(db, facts, { id: row.id, digest: digest(row), controllerDigest: owner.controllerDigest,
    supervisorDigest: owner.supervisorDigest }, false);
}

function runtimeFiles(skill: { bundle: { digest: string; manifestDigest: string; fileCount: number; totalBytes: number } },
  text: string): FileManifestEntry[] {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024 || sha(text) !== skill.bundle.manifestDigest) fail();
  const manifest = JSON.parse(text);
  if (manifest.schema !== "paperclip.runtime-asset-manifest.v1" || manifest.digest !== skill.bundle.digest
    || manifest.fileCount !== skill.bundle.fileCount || manifest.totalBytes !== skill.bundle.totalBytes || !Array.isArray(manifest.files)
    || manifest.files.length !== manifest.fileCount || manifest.files.length > 10_000 || sha(JSON.stringify(manifest.files)) !== manifest.digest) fail();
  let total = 0; const paths = new Set<string>();
  const files = manifest.files.map((file: { path: string; size: number; sha256: string; mode: number }) => {
    assertSkillSnapshotPath(file.path);
    if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isInteger(file.mode) || (file.mode & ~0o555) !== 0) fail();
    paths.add(file.path); total += file.size;
    if (total > skill.bundle.totalBytes) fail();
    return { ...file, executable: Boolean(file.mode & 0o111) };
  });
  if (total !== skill.bundle.totalBytes) fail();
  return files;
}

async function localFacts(facts: Awaited<ReturnType<typeof databaseFacts>>, assets: Awaited<ReturnType<typeof assetBindings>>,
  storage: StorageService, db: Db, verifyStorage: boolean, signal: AbortSignal, controller: ControllerBinding, plans = new Map<string, FileManifestEntry[]>()) {
  const root = scopedRunnerdStateRoot(facts.execution), metadata: unknown[] = [], store = skillPackageStore(db, storage);
  const stat = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const rootStat = await stat(root);
  if (rootStat) {
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail();
    const names = await readdir(root);
    if (names.some(name => !isKnownNativeSessionRootEntry(name))) fail();
    const control = await stat(join(root, "control-plane"));
    if (control && (!control.isDirectory() || control.isSymbolicLink()
      || (await readdir(join(root, "control-plane"))).some(name => name !== "control-plane-state.json"))) fail();
    for (const name of ["continuity-breaks", "authority-epochs", "provider-artifacts", "failover-backups"]) {
      const entry = await stat(join(root, name));
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(join(root, name))).length)) fail();
    }
  }
  const material = await readLegacyNativeControllerArchiveDigests(facts.source);
  if (controller.archive ? material.controllerDigest !== controller.archive.controllerDigest
    || (material.supervisorDigest ?? null) !== controller.archive.supervisorDigest
    : material.controllerDigest !== undefined || material.supervisorDigest !== undefined) fail();
  metadata.push({ controller: material.controllerDigest ?? null, supervisor: material.supervisorDigest ?? null });
  for (const candidate of ["current", "previous"]) if (await stat(join(root, "failover-backups", candidate))) fail();
  if (verifyStorage) for (const row of assets.packages.values()) if (!await store.verifyDurable(row.companyId, row.id, signal)) fail();
  const runtime = "runtimeContext" in facts.execution ? facts.execution.runtimeContext : null;
  if (!runtime) fail();
  let bytes = 0, count = 0;
  for (const directory of resolveNativeHarnessPersistenceProfile(facts.execution).directories) {
    const path = join(root, directory.name), directoryStat = await stat(path);
    metadata.push([directory.name, directoryStat && [directoryStat.dev, directoryStat.ino, directoryStat.ctimeMs]]);
    if (!directoryStat) continue;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
    const walk = async (current: string, relative: string): Promise<void> => {
      for (const name of (await readdir(current)).sort()) {
        signal.throwIfAborted(); if (++count > 25_000) fail();
        const rel = relative ? `${relative}/${name}` : name, file = join(current, name), s = await lstat(file);
        if (s.isSymbolicLink() || !s.isFile() && !s.isDirectory()) fail();
        metadata.push([directory.name, rel, s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs]);
        if (directory.excludeEntries.some(excluded => rel === excluded || rel.startsWith(`${excluded}/`))) continue;
        if (directory.name !== "codex-home" || rel !== "skills" && !rel.startsWith("skills/")) fail();
        if (s.isDirectory()) await walk(file, rel);
      }
    };
    await walk(path, "");
    if (directory.name !== "codex-home") continue;
    const skillRoot = join(path, "skills");
    if (!await stat(skillRoot)) continue;
    for (const name of await readdir(skillRoot)) {
      const skill = runtime.skills.find(skill => skill.runtimeName === name);
      if (!skill || !/^[A-Za-z0-9._-]+$/.test(name)) fail();
      const projected = join(skillRoot, name); let files: FileManifestEntry[];
      if (!verifyStorage) {
        const captured = plans.get(projected); if (!captured) fail(); files = captured;
      } else if (!skill.versionId) {
        const preserved = assets.preservation?.assets.find(asset => asset.key === skill.key && asset.runtimeName === name);
        if (!preserved) fail(); files = runtimeFiles(skill, preserved.manifestText);
        const manifest = await store.manifest(facts.anchor.companyId, preserved.packageSnapshotId, signal);
        if (manifest.files.length !== files.length || files.some(file => !manifest.files.some(actual => actual.path === file.path
          && actual.sha256 === file.sha256 && actual.size === file.size && actual.executable === file.executable))) fail();
      } else {
        const version = assets.versions.find(version => version.id === skill.versionId); if (!version) fail();
        const id = version.repositorySnapshotId ?? version.packageSnapshotId;
        const manifest = id ? await store.manifest(facts.anchor.companyId, id, signal) : skillPackageManifest(version.fileInventory);
        let projectedFiles = manifest.files;
        if (version.repositorySnapshotId) {
          if (!version.repositorySkillPath) fail();
          const wanted = new Set([version.repositorySkillPath, posix.join(posix.dirname(version.repositorySkillPath), "agents/openai.yaml")]);
          const authored = [];
          for (const file of manifest.files.filter(file => wanted.has(file.path))) {
            const handle = await open(join(projected, REPOSITORY_CONTENT_DIR, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
            try { const s = await handle.stat(); if (!s.isFile() || s.size !== file.size || s.size > 4 * 1024 * 1024) fail();
              const bytes = await handle.readFile(); if (sha(bytes) !== file.sha256) fail();
              authored.push({ ...file, content: bytes.toString(file.encoding) });
            } finally { await handle.close(); }
          }
          projectedFiles = [...manifest.files.map(file => ({ ...file, path: `${REPOSITORY_CONTENT_DIR}/${file.path}` })),
            ...repositorySkillProjection(authored, version.repositorySkillPath).filter(file => !file.path.startsWith(`${REPOSITORY_CONTENT_DIR}/`))
              .map(file => { const bytes = skillFileBytes(file); return { ...file, size: bytes.length, sha256: sha(bytes), executable: Boolean(file.executable), encoding: file.encoding ?? "utf8" as const }; })];
        } else if (version.packageFileMap) projectedFiles = version.packageFileMap.map(mapping => {
          const file = manifest.files.find(file => file.path === mapping.sourcePath); if (!file) fail(); return { ...file, path: mapping.path };
        });
        files = projectedFiles.map(file => ({ path: file.path, size: file.size, sha256: file.sha256, executable: file.executable, mode: file.executable ? 0o555 : 0o444 }));
        const runtimeManifest = files.map(({ path, size, sha256, mode }) => ({ path, sha256, mode, size })).sort((a, b) => a.path.localeCompare(b.path));
        if (sha(JSON.stringify(runtimeManifest)) !== skill.bundle.digest || files.length !== skill.bundle.fileCount
          || files.reduce((n, file) => n + file.size, 0) !== skill.bundle.totalBytes) fail();
        runtimeFiles(skill, JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest: skill.bundle.digest,
          fileCount: files.length, totalBytes: skill.bundle.totalBytes, files: runtimeManifest }) + "\n");
      }
      bytes += skill.bundle.totalBytes; if (bytes > 64 * 1024 * 1024) fail();
      if (!await verifyFileManifest(projected, files)) fail();
      plans.set(projected, files);
    }
  }
  return { digest: digest(metadata), plans };
}

export async function preserveNativeHarnessFilesystemIndependence(db: Db, input: Scope & {
  source: OriginalHarnessVolumeCapability; storage: StorageService; signal: AbortSignal;
}) {
  await assertOriginalHarnessVolumeSource(input.source); input.signal.throwIfAborted();
  if (input.storage.provider !== "s3") fail();
  const facts = await databaseFacts(db, input, false), assets = await assetBindings(db, facts.anchor, facts.source.id);
  const controller = await preserveControllerEvidence(db, facts, input);
  const local = await localFacts(facts, assets, input.storage, db, true, input.signal, controller), localFactsDigest = local.digest;
  const previous = facts.anchor.runnerProfileJson?.[KEY];
  if (previous != null) {
    if (!await hasValidNativeHarnessFilesystemIndependence(db, input)) fail();
    return { scopeDigest: input.scopeDigest, sourceRunId: facts.source.id, receiptDigest: digest(previous) };
  }
  const receipt: Receipt = { schema: SCHEMA, selectedSessionId: input.selectedSessionId, scopeDigest: input.scopeDigest,
    lastRunId: facts.anchor.id, sourceRunId: facts.source.id, factsDigest: facts.factsDigest,
    sourceCapabilityFingerprint: input.source.fingerprint, localFactsDigest, assetsDigest: digest(assets.bindings), ...assets.bindings, controller, observedAt: new Date().toISOString() };
  let publishedReceipt = receipt;
  const publications: ActivityPublication[] = [];
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`set local lock_timeout = '1s'`);
    const current = await databaseFacts(tx, input, true);
    if (current.factsDigest !== facts.factsDigest) fail();
    for (const row of [...assets.versions].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.select({ id: companySkillVersions.id }).from(companySkillVersions).where(eq(companySkillVersions.id, row.id)).for("share");
    }
    for (const row of [...assets.packages.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.select({ id: companySkillRepositorySnapshots.id }).from(companySkillRepositorySnapshots)
        .where(eq(companySkillRepositorySnapshots.id, row.id)).for("update");
    }
    const currentAssets = await assetBindings(tx, current.anchor, current.source.id);
    const currentController = await controllerBinding(tx, current, controller.archive, true);
    if (digest(currentAssets.bindings) !== receipt.assetsDigest
      || digest(currentController) !== digest(controller)
      || (await localFacts(current, currentAssets, input.storage, tx, false, input.signal, controller, local.plans)).digest !== localFactsDigest) fail();
    await assertOriginalHarnessVolumeSource(input.source); input.signal.throwIfAborted();
    const existing = current.anchor.runnerProfileJson?.[KEY];
    if (existing != null) {
      const winner = matchingReceipt(existing, current, input, currentAssets.bindings, currentController);
      if (!winner) fail();
      publishedReceipt = winner;
      return;
    }
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...current.anchor.runnerProfileJson, [KEY]: receipt } })
      .where(and(eq(heartbeatRuns.id, current.anchor.id), eq(heartbeatRuns.companyId, input.companyId)));
    await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "native-harness-preservation",
      action: "native_harness_filesystem_independence_verified", entityType: "heartbeat_run", entityId: current.anchor.id,
      agentId: current.anchor.agentId, runId: current.anchor.id, details: { scopeDigest: input.scopeDigest,
        sourceRunId: current.source.id, sourceCapabilityFingerprint: receipt.sourceCapabilityFingerprint, factsDigest: receipt.factsDigest } }, publications);
  });
  for (const publication of publications) publishActivity(publication);
  return { scopeDigest: input.scopeDigest, sourceRunId: facts.source.id, receiptDigest: digest(publishedReceipt) };
}
