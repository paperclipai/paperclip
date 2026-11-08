import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, posix } from "node:path";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { agentTaskSessions, companySkillRepositorySnapshots, companySkillVersions, environmentLeases,
  heartbeatRuns, issues, nativeHarnessBackups, nativeRunnerCheckpoints, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "../remote-execution-termination.js";
import { verifyFileManifest, type FileManifestEntry } from "../file-manifest-cache.js";
import { skillPackageStore } from "../skill-package-store.js";
import { skillPackageManifest } from "../skill-package-files.js";
import { assertSkillSnapshotPath, skillFileBytes } from "../skill-snapshot.js";
import { REPOSITORY_CONTENT_DIR, repositorySkillProjection } from "../skill-repository-package.js";
import { captureLegacyDurablePrpCheckpoint, inspectDurablePrpCheckpointHeader, parseNativeExecutionInput,
  type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { readRuntimeSkillPreservation } from "./runtime-skill-preservation-reference.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { nativeControllerMigrationDescriptor, resolveNativeHarnessPersistenceProfile, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { readNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import { assertOriginalHarnessVolumeSource, type OriginalHarnessVolumeCapability } from "./native-harness-original-volume.js";
import { isKnownNativeSessionRootEntry } from "./native-session-root-entries.js";
import { readLegacyNativeControllerArchiveSource, readLegacyNativeControllerArchiveDigests } from "./native-controller-migration.js";
import { archiveNativeControllerSourceEvidence, legacyNativeControllerArchive, nativeControllerEvidenceDescriptor,
  nativeControllerHistoryManifest, nativeControllerWebManifest, NATIVE_CONTROLLER_WEB_LIMITS, type NativeControllerWebEntry,
  type NativeControllerHistoryEntry, type NativeControllerHistoryManifestEntry } from "./native-controller-archive.js";
import { nativeControllerArchiveCoordinatorDigest, nativeControllerArchiveProfileDigest, type SettledControllerArchiveOwner } from "./native-controller-archive-source.js";
import { loadNativeRunnerCheckpoint, loadNativeRunnerCheckpointHeader } from "./native-runner-checkpoint.js";
import { readNativeControllerRecovery } from "./native-controller-recovery.js";
import { verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";

const KEY = "nativeHarnessFilesystemIndependence";
const SCHEMA = "paperclip.native-harness-filesystem-independence.v1";
const WEB_SCHEMA = "paperclip.native-harness-web-evidence.v1";
const terminal = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => nativeSha256(JSON.parse(JSON.stringify(value)));
function fail(): never { throw new Error("native_harness_filesystem_independence_unverified"); }
const profile = (value: Record<string, unknown> | null) => { const copy = { ...value }; delete copy[KEY]; return copy; };
type PackageBinding = { id: string; digest: string };
type VersionBinding = { id: string; digest: string };
type HistoryEpoch = { name: string; runId: string; identity: DurableRecoveryIdentity; identityDigest: string; headerDigest: string | null };
type HistoryBinding = { entries: NativeControllerHistoryManifestEntry[]; epochs: HistoryEpoch[] };
type CapturedHistory = { entries: NativeControllerHistoryEntry[]; binding: HistoryBinding; localDigest: string };
type WebSkill = { runId: string; key: string; runtimeName: string; versionId: string | null; bundleDigest: string;
  manifestDigest: string; fileCount: number; totalBytes: number };
type WebBinding = { entries: NativeControllerHistoryManifestEntry[]; skills: WebSkill[]; rootPresent: boolean;
  profileDigest: string; controllerAbsent: boolean; excluded: Array<{ path: string; type: "directory" | "file"; mode: number; size: number }> };
type CapturedWeb = { entries: NativeControllerWebEntry[]; binding: WebBinding; localDigest: string };
type ControllerBinding = { checkpointPartsDigest: string; history?: HistoryBinding; archive: null | { id: string; digest: string;
  controllerDigest: string | null; supervisorDigest: string | null } };
type Receipt = { schema: typeof SCHEMA | typeof WEB_SCHEMA; selectedSessionId: string; lastRunId: string; sourceRunId: string; scopeDigest: string;
  factsDigest: string; sourceCapabilityFingerprint: string; localFactsDigest: string; assetsDigest: string;
  packages: PackageBinding[]; versions: VersionBinding[]; controller: ControllerBinding; observedAt: string; web?: WebBinding };
type Scope = { companyId: string; selectedSessionId: string; scopeDigest: string };
type Run = typeof heartbeatRuns.$inferSelect;
const evidenceOwners = new WeakMap<SettledControllerArchiveOwner, { scope: Scope; factsDigest: string;
  history?: CapturedHistory; web?: CapturedWeb; archiveManifestSha256: string; signal: AbortSignal }>();

function webLeaseBinding(lease: typeof environmentLeases.$inferSelect) {
  const fields = Object.fromEntries(Object.entries(lease).filter(([key]) => !["status", "releasedAt", "updatedAt", "lastUsedAt", "expiresAt", "failureReason", "cleanupStatus"].includes(key)));
  const metadata = Object.fromEntries(Object.entries(lease.metadata ?? {}).filter(([key]) => !["pendingCleanupAttemptId", "pendingCleanupInFlight",
    "pendingCleanupLeaseExpiresAtMs", "pendingCleanupRetryAfterMs", "pendingCleanupRetryAttempts", "pendingCleanupRetryCapWarned",
    "pendingCleanupController", "pendingCleanupManualAttemptId", "remoteExecutionTermination", "sandboxStopAndRetainReceipt", "sandboxState", "resumedFromState"].includes(key)));
  return { ...fields, metadata };
}

async function databaseFacts(db: Db, input: Scope, lock: boolean, webOnly = false) {
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
    if (!webOnly) {
      const resolved = await resolveRemoteTerminationLease(db, lease);
      const receipt = resolved.metadata?.remoteExecutionTermination as { state?: unknown } | undefined;
      if (!hasRemoteTerminationReceipt(resolved) || receipt?.state !== "destroyed") fail();
      terminations.push({ leaseId: lease.id, receipt });
    }
    const stamp = readNativeHarnessBackupStamp(lease.metadata?.nativeHarnessBackup, lease.providerLeaseId ?? "");
    if (stamp?.sessionScopeSha256 === input.scopeDigest && stamp.normalizedSessionId === anchor.nativeSessionId
      && runs.some(run => run.runnerInstanceId === stamp.runnerInstanceId)
      && leases.some(row => row.providerLeaseId === stamp.sourceProviderLeaseId)) matchingStamp = true;
  }
  if (!matchingStamp) fail();
  const factsDigest = digest({ selection, runs: runs.map(run => ({ ...run, runnerProfileJson: profile(run.runnerProfileJson) })), owners,
    task: { id: task.id, executionRunId: task.executionRunId, checkoutRunId: task.checkoutRunId },
    leases: webOnly ? leases.map(webLeaseBinding) : leases, terminations,
    sourceRunId: source.id, sourceProfile: source.runnerProfileJson });
  return { anchor, execution, source, factsDigest, runs };
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
  bindings: Awaited<ReturnType<typeof assetBindings>>["bindings"], controller: ControllerBinding, web?: WebBinding): Receipt | null {
    const receipt = value as Receipt | undefined;
    if (receipt?.schema !== (web ? WEB_SCHEMA : SCHEMA) || receipt.selectedSessionId !== input.selectedSessionId || receipt.scopeDigest !== input.scopeDigest
      || receipt.lastRunId !== facts.anchor.id || receipt.sourceRunId !== facts.source.id || receipt.factsDigest !== facts.factsDigest
      || !/^[a-f0-9]{64}$/.test(receipt.sourceCapabilityFingerprint) || !/^[a-f0-9]{64}$/.test(receipt.localFactsDigest)
      || !Number.isFinite(Date.parse(receipt.observedAt)) || !Array.isArray(receipt.packages) || !Array.isArray(receipt.versions)) return null;
    return digest(bindings) === receipt.assetsDigest && digest(receipt.packages) === digest(bindings.packages)
      && digest(receipt.versions) === digest(bindings.versions) && receipt.controller != null
      && digest(receipt.controller) === digest(controller) && digest(receipt.web ?? null) === digest(web ?? null) ? receipt : null;
}

export async function hasValidNativeHarnessFilesystemIndependence(db: Db, input: Scope): Promise<boolean> {
  try {
    const [anchor] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(agentTaskSessions)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, agentTaskSessions.lastRunId), eq(heartbeatRuns.companyId, agentTaskSessions.companyId),
        eq(heartbeatRuns.agentId, agentTaskSessions.agentId)))
      .where(and(eq(agentTaskSessions.id, input.selectedSessionId), eq(agentTaskSessions.companyId, input.companyId)));
    const value = anchor?.profile?.[KEY] as Receipt | undefined;
    const webOnly = value?.schema === WEB_SCHEMA;
    const facts = await databaseFacts(db, input, false, webOnly);
    const existing = facts.anchor.runnerProfileJson?.[KEY] as Receipt | undefined;
    if (webOnly && (!existing?.web || !validWebBinding(facts, existing.web))) return false;
    const bindings = webOnly ? { packages: [], versions: [] } : (await assetBindings(db, facts.anchor, facts.source.id)).bindings;
    const controller = await controllerBinding(db, facts, existing?.controller?.archive ?? null, false, existing?.controller?.history, existing?.web);
    return matchingReceipt(existing, facts, input, bindings, controller, existing?.web) !== null;
  } catch { return false; }
}

export async function assertNativeHarnessFilesystemArchiveSource(db: Db, owner: SettledControllerArchiveOwner) {
  const registered = evidenceOwners.get(owner);
  if (!registered || !owner.filesystemIndependence) fail();
  const facts = await databaseFacts(db, registered.scope, true, registered.web !== undefined);
  if (facts.factsDigest !== registered.factsDigest || facts.factsDigest !== owner.filesystemIndependence.factsDigest
    || facts.source.id !== owner.runId || facts.anchor.id !== owner.selectedLastRunId) fail();
  const history = await captureAuthorityHistory(db, facts, registered.signal);
  if (history?.localDigest !== registered.history?.localDigest || digest(history?.binding ?? null) !== digest(registered.history?.binding ?? null)) fail();
  if (registered.web) {
    const web = await captureWebEvidence(facts, registered.signal);
    if (web.localDigest !== registered.web.localDigest || digest(web.binding) !== digest(registered.web.binding)) fail();
  }
}

export function assertNativeHarnessFilesystemArchiveContents(owner: SettledControllerArchiveOwner, archive: { manifestSha256: string }) {
  if (evidenceOwners.get(owner)?.archiveManifestSha256 !== archive.manifestSha256) fail();
}

async function historyEpochBinding(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>,
  epoch: Omit<HistoryEpoch, "headerDigest"> & { headerDigest?: string | null }, lock: boolean, contents?: string): Promise<HistoryEpoch> {
  if (!/^epoch-[a-f0-9]{24}$/.test(epoch.name) || !/^[a-f0-9]{64}$/.test(epoch.identityDigest)) fail();
  const run = facts.runs.find(run => run.id === epoch.runId);
  if (!run || run.id === facts.source.id || run.createdAt >= facts.source.createdAt
    || basename(scopedRunnerdStateRoot(parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput)))
      !== basename(scopedRunnerdStateRoot(facts.execution))) fail();
  const execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput), identity = epoch.identity;
  if (!identity || identity.runId !== run.id || identity.runnerInstanceId !== run.runnerInstanceId
    || identity.normalizedSessionId !== run.nativeSessionId || digest(identity) !== epoch.identityDigest
    || execution.binding.companyId !== run.companyId || execution.binding.agentId !== run.agentId
    || execution.binding.issueId !== run.nativeIssueId || execution.binding.runId !== run.id
    || execution.session.normalizedSessionId !== run.nativeSessionId) fail();
  const query = db.select().from(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, run.companyId),
    eq(nativeRunnerCheckpoints.issueId, facts.anchor.nativeIssueId!), eq(nativeRunnerCheckpoints.runId, run.id),
    eq(nativeRunnerCheckpoints.part, "header")));
  const [row] = await (lock ? query.for("share") : query);
  const header = row && await loadNativeRunnerCheckpointHeader(db, { companyId: run.companyId, issueId: facts.anchor.nativeIssueId!, runId: run.id });
  if (row ? !header || digest(inspectDurablePrpCheckpointHeader(header)) !== epoch.identityDigest
    : identity.environmentLeaseId !== execution.binding.executionWorkspaceId) fail();
  const headerDigest = row ? digest(row) : null;
  if (epoch.headerDigest !== undefined && epoch.headerDigest !== headerDigest) fail();
  if (contents !== undefined) {
    const artifact = header ? JSON.parse(header) : null;
    try {
      captureLegacyDurablePrpCheckpoint(contents, { runId: run.id, runnerInstanceId: identity.runnerInstanceId,
        normalizedSessionId: identity.normalizedSessionId }, artifact ? { version: artifact.runnerVersion, digest: artifact.runnerDigest } : undefined);
    } catch (error) {
      if (row || !(error instanceof Error) || error.message !== "native_runner_checkpoint_artifact_unproven") throw error;
    }
  }
  return { name: epoch.name, runId: run.id, identity, identityDigest: epoch.identityDigest, headerDigest };
}

async function captureAuthorityHistory(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>, signal: AbortSignal): Promise<CapturedHistory | undefined> {
  signal.throwIfAborted();
  const root = scopedRunnerdStateRoot(facts.execution), base = join(root, "authority-epochs");
  const stat = await lstat(base).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || await realpath(root) !== root || await realpath(base) !== base) fail();
  const directoryNames = async (path: string) => {
    const names: string[] = [];
    for await (const entry of await opendir(path)) {
      signal.throwIfAborted(); if (names.length >= 128) fail(); names.push(entry.name);
    }
    return names.sort();
  };
  const names = await directoryNames(base); if (!names.length) return undefined;
  const entries: NativeControllerHistoryEntry[] = [], metadata: unknown[] = [], inodes = new Set<string>();
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    if (entries.length >= 128 || !/^authority-epochs(?:\/epoch-[a-f0-9]{24}(?:\/control-plane(?:\/control-plane-state\.json)?|\/runner-state\.json)?)?$/.test(path)) fail();
    const file = join(root, path), s = await lstat(file);
    if (s.isSymbolicLink() || !s.isDirectory() && !s.isFile() || s.dev !== stat.dev || s.uid !== stat.uid || (s.mode & 0o7000) !== 0) fail();
    metadata.push([path, s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs]);
    if (s.isDirectory()) {
      if (path.endsWith(".json")) fail();
      entries.push({ path, mode: s.mode & 0o777, type: "directory" });
      const children = await directoryNames(file);
      for (const name of children) await visit(`${path}/${name}`);
      const after = await lstat(file);
      if (after.dev !== s.dev || after.ino !== s.ino || after.ctimeMs !== s.ctimeMs
        || digest(await directoryNames(file)) !== digest(children)) fail();
    } else {
      if (!path.endsWith("/control-plane/control-plane-state.json") && !path.endsWith("/runner-state.json")) fail();
      const key = `${s.dev}:${s.ino}`;
      if (s.nlink !== 1 || inodes.has(key) || s.size > 16 * 1024 * 1024 || (bytes += s.size) > 64 * 1024 * 1024) fail();
      inodes.add(key);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size) fail();
        const buffer = Buffer.alloc(s.size + 1); let length = 0;
        while (length < buffer.length) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break; length += bytesRead;
        }
        if (length !== s.size) fail();
        const contents = buffer.subarray(0, length), after = await handle.stat(), named = await lstat(file);
        if (after.size !== s.size || after.ctimeMs !== s.ctimeMs || after.mtimeMs !== s.mtimeMs
          || named.dev !== s.dev || named.ino !== s.ino || !Buffer.from(contents.toString("utf8")).equals(contents)) fail();
        entries.push({ path, mode: s.mode & 0o777, type: "file", content: contents.toString("utf8") });
      } finally { await handle.close(); }
    }
  };
  await visit("authority-epochs");
  const epochs: HistoryEpoch[] = [];
  for (const name of names) {
    const file = entries.find(entry => entry.path === `authority-epochs/${name}/control-plane/control-plane-state.json`);
    if (!file || file.type !== "file") fail();
    const value = JSON.parse(file.content), identity = value.identity;
    if (!identity || name !== `epoch-${sha(JSON.stringify(identity)).slice(0, 24)}`) fail();
    const epoch = await historyEpochBinding(db, facts, { name, runId: identity.runId, identity, identityDigest: digest(identity) }, false, file.content);
    const runner = entries.find(entry => entry.path === `authority-epochs/${name}/runner-state.json`);
    if (runner) {
      if (runner.type !== "file") fail();
      const state = JSON.parse(runner.content);
      if (state.schema !== "paperclip.runner.durable.state.v1" || state.lifecycle !== "suspended"
        || Object.entries(identity).some(([key, value]) => state[key] !== value)) fail();
    }
    epochs.push(epoch);
  }
  return { entries, binding: { entries: nativeControllerHistoryManifest(entries), epochs }, localDigest: digest(metadata) };
}

async function controllerBinding(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>, archive: ControllerBinding["archive"], lock: boolean,
  history?: HistoryBinding, web?: WebBinding): Promise<ControllerBinding> {
  const partsQuery = db.select().from(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, facts.anchor.companyId),
    eq(nativeRunnerCheckpoints.issueId, facts.anchor.nativeIssueId!), eq(nativeRunnerCheckpoints.runId, facts.source.id)))
    .orderBy(asc(nativeRunnerCheckpoints.part));
  const parts = await (lock ? partsQuery.for("share") : partsQuery);
  if (archive) {
    if (web && (!validWebBinding(facts, web) || web.controllerAbsent !== (archive.controllerDigest === null))) fail();
    if (web && (web.entries.find(entry => entry.path === "web-supervisor.json" && entry.type === "file") as
      Extract<NativeControllerHistoryManifestEntry, { type: "file" }> | undefined)?.sha256 !== (archive.supervisorDigest ?? undefined)) fail();
    if (!parts.some(row => row.part === "header") || !readNativeControllerRecovery(
      facts.source.runnerProfileJson.nativeControllerRecovery, facts.source.runnerProfileJson.sessionCheckpoint)) fail();
    const rowQuery = db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, facts.anchor.companyId),
      eq(nativeHarnessBackups.runId, facts.source.id), eq(nativeHarnessBackups.id, archive.id)));
    const [row] = await (lock ? rowQuery.for("share") : rowQuery);
    if (!row || !["current", "superseded"].includes(row.status) || digest(row) !== archive.digest) fail();
    if (history) {
      if (!Array.isArray(history.entries) || !Array.isArray(history.epochs) || !history.epochs.length || history.epochs.length > 32
        || new Set(history.epochs.map(epoch => epoch.name)).size !== history.epochs.length) fail();
      const paths = new Set(["authority-epochs"]);
      for (const epoch of history.epochs) {
        if (digest(await historyEpochBinding(db, facts, epoch, lock)) !== digest(epoch)) fail();
        for (const suffix of ["", "/control-plane", "/control-plane/control-plane-state.json"]) paths.add(`authority-epochs/${epoch.name}${suffix}`);
        if (history.entries.some(entry => entry.path === `authority-epochs/${epoch.name}/runner-state.json`)) paths.add(`authority-epochs/${epoch.name}/runner-state.json`);
      }
      if (paths.size !== history.entries.length || history.entries.some(entry => !paths.has(entry.path)
        || entry.type !== (entry.path.endsWith(".json") ? "file" : "directory"))) fail();
    }
    const descriptor = nativeControllerEvidenceDescriptor({ companyId: facts.anchor.companyId, issueId: facts.anchor.nativeIssueId!,
      runId: facts.source.id, controllerDigest: archive.controllerDigest, supervisorDigest: archive.supervisorDigest,
      purpose: "filesystem_independence", history: history?.entries, historyBindingDigest: history ? digest(history) : undefined,
      ...(web ? { web: { entries: web.entries, bindingDigest: digest(web) } } : {}) });
    if (row.scopeDigest !== descriptor.scopeDigest || row.manifestSha256 !== descriptor.manifestSha256) fail();
  } else if (history || web) {
    fail();
  }
  return { checkpointPartsDigest: digest(parts), archive, ...(history ? { history } : {}) };
}

async function preserveControllerEvidence(db: Db, facts: Awaited<ReturnType<typeof databaseFacts>>, input: Scope & {
  source: OriginalHarnessVolumeCapability; storage: StorageService; signal: AbortSignal;
}, history?: CapturedHistory, web?: CapturedWeb): Promise<ControllerBinding> {
  const material = await readLegacyNativeControllerArchiveSource(facts.source);
  if (material.paths.root !== scopedRunnerdStateRoot(facts.execution)) fail();
  if (material.controller === undefined && !web) {
    if (material.supervisor !== undefined || history) fail();
    return controllerBinding(db, facts, null, false);
  }
  const checkpoint = await loadNativeRunnerCheckpoint(db, { companyId: input.companyId, issueId: facts.anchor.nativeIssueId!, runId: facts.source.id });
  if (!checkpoint || !readNativeControllerRecovery(facts.source.runnerProfileJson.nativeControllerRecovery,
    facts.source.runnerProfileJson.sessionCheckpoint)) fail();
  if (web && material.supervisor !== undefined) {
    const saved = JSON.parse(material.supervisor), identity = saved.snapshot?.identity;
    if (saved.schema !== "paperclip.native-session-supervisor.v1" || identity?.companyId !== facts.anchor.companyId
      || identity.agentId !== facts.anchor.agentId || identity.issueId !== facts.anchor.nativeIssueId
      || identity.sessionId !== facts.anchor.nativeSessionId || !facts.runs.some(run => run.id === identity.runId)) fail();
  }
  if (material.controller !== undefined) {
    const identity = JSON.parse(material.controller).identity as Record<string, unknown> | undefined;
    if (identity?.runId !== facts.source.id || identity.runnerInstanceId !== facts.source.runnerInstanceId
      || identity.normalizedSessionId !== facts.anchor.nativeSessionId) fail();
    const captured = captureLegacyDurablePrpCheckpoint(material.controller, { runId: facts.source.id,
      runnerInstanceId: facts.source.runnerInstanceId!, normalizedSessionId: facts.anchor.nativeSessionId! },
      { version: checkpoint.runnerVersion, digest: checkpoint.runnerDigest });
    if (captured.records.size !== checkpoint.records.size || [...captured.records].some(([key, value]) => {
      const durable = checkpoint.records.get(key); return durable === undefined || digest(JSON.parse(value)) !== digest(JSON.parse(durable));
    })) fail();
  }
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.runId, facts.source.id)));
  if (!coordinator) fail();
  const owner: SettledControllerArchiveOwner = Object.freeze({ kind: "settled_controller_archive", companyId: input.companyId,
    issueId: facts.anchor.nativeIssueId!, agentId: facts.anchor.agentId, runId: facts.source.id, sessionId: facts.anchor.nativeSessionId!,
    selectedSessionId: input.selectedSessionId, selectedLastRunId: facts.anchor.id,
    profileDigest: nativeControllerArchiveProfileDigest(facts.source.runnerProfileJson), coordinatorDigest: nativeControllerArchiveCoordinatorDigest(coordinator),
    controllerDigest: material.controller === undefined ? null : sha(material.controller), supervisorDigest: material.supervisor === undefined ? null : sha(material.supervisor),
    filesystemIndependence: Object.freeze({ source: input.source, scopeDigest: input.scopeDigest, factsDigest: facts.factsDigest }) });
  const source = { companyId: input.companyId, issueId: facts.anchor.nativeIssueId!, runId: facts.source.id,
    controller: material.controller, supervisor: material.supervisor, purpose: "filesystem_independence" as const,
    ...(history ? { history: history.entries, historyBindingDigest: digest(history.binding) } : {}),
    ...(web ? { web: { entries: web.entries, bindingDigest: digest(web.binding) } } : {}) };
  const descriptor = legacyNativeControllerArchive(source);
  evidenceOwners.set(owner, { scope: { companyId: input.companyId, selectedSessionId: input.selectedSessionId, scopeDigest: input.scopeDigest },
    factsDigest: facts.factsDigest, history, web, archiveManifestSha256: descriptor.manifestSha256, signal: input.signal });
  await archiveNativeControllerSourceEvidence(db, { ...source, onlineOwner: owner, storage: input.storage, signal: input.signal });
  const [row] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, input.companyId),
    eq(nativeHarnessBackups.runId, facts.source.id), eq(nativeHarnessBackups.scopeDigest, descriptor.scopeDigest),
    eq(nativeHarnessBackups.manifestSha256, descriptor.manifestSha256), eq(nativeHarnessBackups.status, "current")));
  if (!row) fail();
  if (!await verifyDurableNativeHarnessBackup({ db, storage: input.storage, companyId: input.companyId,
    scopeDigest: descriptor.scopeDigest, manifestSha256: descriptor.manifestSha256, backupId: row.id, signal: input.signal })) fail();
  return controllerBinding(db, facts, { id: row.id, digest: digest(row), controllerDigest: owner.controllerDigest,
    supervisorDigest: owner.supervisorDigest }, false, history?.binding, web?.binding);
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

function webSkills(facts: Awaited<ReturnType<typeof databaseFacts>>): WebSkill[] {
  const rows = facts.source.id === facts.anchor.id ? [facts.anchor] : [facts.anchor, facts.source];
  return rows.flatMap(row => {
    const input = parseNativeExecutionInput(row.runnerProfileJson?.nativeExecutionInput);
    if (!("runtimeContext" in input) || input.binding.companyId !== row.companyId || input.binding.agentId !== row.agentId
      || input.binding.issueId !== row.nativeIssueId || input.binding.runId !== row.id
      || input.session.normalizedSessionId !== row.nativeSessionId) fail();
    return input.runtimeContext.skills.map(skill => ({ runId: row.id, key: skill.key, runtimeName: skill.runtimeName,
      versionId: skill.versionId, bundleDigest: skill.bundle.digest, manifestDigest: skill.bundle.manifestDigest,
      fileCount: skill.bundle.fileCount, totalBytes: skill.bundle.totalBytes }));
  }).sort((a, b) => `${a.runId}:${a.key}:${a.runtimeName}`.localeCompare(`${b.runId}:${b.key}:${b.runtimeName}`));
}

function webProfile(facts: Awaited<ReturnType<typeof databaseFacts>>) {
  return resolveNativeHarnessPersistenceProfile(facts.execution).directories
    .map(directory => ({ name: directory.name, location: directory.location, excludeEntries: directory.excludeEntries }));
}

function validWebBinding(facts: Awaited<ReturnType<typeof databaseFacts>>, web: WebBinding): boolean {
  try {
    if (!web || typeof web.rootPresent !== "boolean" || typeof web.controllerAbsent !== "boolean" || !Array.isArray(web.entries)
      || !Array.isArray(web.skills) || !Array.isArray(web.excluded)
      || web.entries.length + web.excluded.length > NATIVE_CONTROLLER_WEB_LIMITS.entries
      || web.profileDigest !== digest(webProfile(facts)) || digest(web.skills) !== digest(webSkills(facts))) return false;
    const profiles = webProfile(facts), manifests = new Map(web.skills.map(skill => [skill.bundleDigest, skill.manifestDigest]));
    for (const [bundle, manifest] of manifests) if (!web.entries.some(entry => entry.path === `web-manifests/${bundle}.json`
      && entry.type === "file" && entry.sha256 === manifest)) return false;
    if (web.entries.some(entry => {
      if (Buffer.byteLength(entry.path) > NATIVE_CONTROLLER_WEB_LIMITS.pathBytes) return true;
      const [prefix, name, ...rest] = entry.path.split("/");
      if (prefix === "web-supervisor.json") return name !== undefined || entry.type !== "file";
      if (prefix === "web-manifests") return name === undefined ? entry.type !== "directory"
        : !/^[a-f0-9]{64}\.json$/.test(name) || rest.length > 0 || entry.type !== "file" || manifests.get(name.slice(0, -5)) !== entry.sha256;
      if (!["web-home", "web-state"].includes(prefix!)) return true;
      if (!web.rootPresent && name !== undefined) return true;
      if (name === undefined) return entry.type !== "directory";
      if (prefix === "web-state") return !isKnownNativeSessionRootEntry(name) || profiles.some(profile => profile.name === name);
      const profile = profiles.find(profile => profile.name === name), rel = rest.join("/");
      return !profile || profile.excludeEntries.some(excluded => rel === excluded || rel.startsWith(`${excluded}/`));
    })) return false;
    return web.excluded.every(entry => {
      const [name, ...rest] = entry.path.split("/"), rel = rest.join("/"), profile = profiles.find(profile => profile.name === name);
      assertSkillSnapshotPath(entry.path);
      return Buffer.byteLength(entry.path) <= NATIVE_CONTROLLER_WEB_LIMITS.pathBytes
        && profile?.excludeEntries.some(excluded => rel === excluded || rel.startsWith(`${excluded}/`))
        && ["directory", "file"].includes(entry.type) && Number.isInteger(entry.mode) && (entry.mode & ~0o777) === 0
        && Number.isSafeInteger(entry.size) && entry.size >= 0;
    }) && Buffer.byteLength(JSON.stringify({ entries: web.entries, excluded: web.excluded })) <= NATIVE_CONTROLLER_WEB_LIMITS.metadataBytes;
  } catch { return false; }
}

async function captureWebEvidence(facts: Awaited<ReturnType<typeof databaseFacts>>, signal: AbortSignal): Promise<CapturedWeb> {
  const root = scopedRunnerdStateRoot(facts.execution), profiles = webProfile(facts), entries: NativeControllerWebEntry[] = [];
  const metadata: unknown[] = [], excluded: WebBinding["excluded"] = [], inodes = new Set<string>();
  let bytes = 0, count = 0;
  const directoryNames = async (path: string) => {
    const names: string[] = [];
    for await (const entry of await opendir(path)) {
      signal.throwIfAborted(); if (names.length >= NATIVE_CONTROLLER_WEB_LIMITS.entries) fail(); names.push(entry.name);
    }
    return names.sort();
  };
  const stat = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const rootStat = await stat(root), instance = await lstat(resolvePaperclipInstanceRoot());
  const read = async (file: string, s: Stats) => {
    const key = `${s.dev}:${s.ino}`;
    if (!s.isFile() || s.nlink !== 1 || inodes.has(key) || s.dev !== instance.dev || s.uid !== instance.uid
      || (s.mode & 0o7000) !== 0 || await realpath(file) !== file
      || s.size > 16 * 1024 * 1024 || (bytes += s.size) > 64 * 1024 * 1024) fail();
    inodes.add(key);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size) fail();
      const buffer = Buffer.alloc(s.size + 1); let length = 0;
      while (length < buffer.length) { signal.throwIfAborted(); const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat(), named = await lstat(file);
      if (length !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs
        || named.dev !== s.dev || named.ino !== s.ino) fail();
      metadata.push([file, s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs]);
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  };
  const visit = async (file: string, path: string, relative: string): Promise<void> => {
    signal.throwIfAborted(); if (++count > NATIVE_CONTROLLER_WEB_LIMITS.entries
      || Buffer.byteLength(path) > NATIVE_CONTROLLER_WEB_LIMITS.pathBytes) fail(); assertSkillSnapshotPath(path);
    const s = await lstat(file);
    if (s.isSymbolicLink() || !s.isDirectory() && !s.isFile() || s.dev !== instance.dev || s.uid !== instance.uid || (s.mode & 0o7000) !== 0) fail();
    metadata.push([path, s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs]);
    const [name, ...rest] = relative.split("/"), rel = rest.join("/"), profile = profiles.find(profile => profile.name === name);
    if (profile?.excludeEntries.some(exclusion => rel === exclusion || rel.startsWith(`${exclusion}/`))) {
      excluded.push({ path: relative, type: s.isDirectory() ? "directory" : "file", mode: s.mode & 0o777, size: s.isFile() ? s.size : 0 }); return;
    }
    if (s.isFile()) { entries.push({ path, type: "file", mode: s.mode & 0o777, content: await read(file, s) }); return; }
    entries.push({ path, type: "directory", mode: s.mode & 0o777 });
    const names = await directoryNames(file);
    for (const name of names) await visit(join(file, name), `${path}/${name}`, `${relative}/${name}`);
    const after = await lstat(file);
    if (after.dev !== s.dev || after.ino !== s.ino || after.ctimeMs !== s.ctimeMs || digest(await directoryNames(file)) !== digest(names)) fail();
  };
  if (rootStat) {
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root || rootStat.dev !== instance.dev || rootStat.uid !== instance.uid) fail();
    metadata.push([root, rootStat.dev, rootStat.ino, rootStat.mode, rootStat.mtimeMs, rootStat.ctimeMs]);
    const names = await directoryNames(root);
    if (names.some(name => !isKnownNativeSessionRootEntry(name))) fail();
    for (const name of ["continuity-breaks", "provider-artifacts", "failover-backups"]) {
      const s = await stat(join(root, name));
      if (s && (!s.isDirectory() || s.isSymbolicLink() || (await directoryNames(join(root, name))).length)) fail();
    }
    entries.push({ path: "web-home", type: "directory", mode: rootStat.mode & 0o777 },
      { path: "web-state", type: "directory", mode: rootStat.mode & 0o777 });
    for (const name of names) {
      if (["runner", "codex-home", "opencode", "acpx"].includes(name) && !profiles.some(profile => profile.name === name)) fail();
      await visit(join(root, name), `${profiles.some(profile => profile.name === name) ? "web-home" : "web-state"}/${name}`, name);
    }
    if (digest(await directoryNames(root)) !== digest(names)) fail();
  }
  const sourceExecution = parseNativeExecutionInput(facts.source.runnerProfileJson.nativeExecutionInput);
  const supervisor = nativeControllerMigrationDescriptor(sourceExecution, facts.source.runnerProfileJson.nativeToolContractFingerprint).supervisorPath;
  const supervisorStat = sourceExecution.session.lifecyclePolicy.mode === "warm" ? await stat(supervisor) : null;
  if (supervisorStat) {
    const content = await read(supervisor, supervisorStat);
    entries.push({ path: "web-supervisor.json", type: "file", mode: supervisorStat.mode & 0o777, content });
  } else metadata.push(["web-supervisor.json", null]);
  const skills = webSkills(facts);
  if (skills.length) entries.push({ path: "web-manifests", type: "directory", mode: 0o700 });
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.bundleDigest)) continue; seen.add(skill.bundleDigest);
    if (!/^[a-f0-9]{64}$/.test(skill.bundleDigest)) fail();
    const path = join(resolvePaperclipInstanceRoot(), "runtime-context-assets/manifests", `${skill.bundleDigest}.json`), s = await lstat(path);
    const content = await read(path, s);
    runtimeFiles({ bundle: { digest: skill.bundleDigest, manifestDigest: skill.manifestDigest, fileCount: skill.fileCount, totalBytes: skill.totalBytes } }, content.toString("utf8"));
    entries.push({ path: `web-manifests/${skill.bundleDigest}.json`, type: "file", mode: s.mode & 0o777, content });
  }
  if (entries.length + excluded.length > NATIVE_CONTROLLER_WEB_LIMITS.entries) fail();
  const material = await readLegacyNativeControllerArchiveDigests(facts.source);
  const binding: WebBinding = { entries: nativeControllerWebManifest(entries), skills, rootPresent: rootStat !== null,
    profileDigest: digest(profiles), controllerAbsent: material.controllerDigest === undefined, excluded };
  if (!validWebBinding(facts, binding)) fail();
  return { entries, binding, localDigest: digest(metadata) };
}

async function localFacts(facts: Awaited<ReturnType<typeof databaseFacts>>, assets: Awaited<ReturnType<typeof assetBindings>>,
  storage: StorageService, db: Db, verifyStorage: boolean, signal: AbortSignal, controller: ControllerBinding, plans = new Map<string, FileManifestEntry[]>()) {
  const root = scopedRunnerdStateRoot(facts.execution), metadata: unknown[] = [], store = skillPackageStore(db, storage);
  const history = await captureAuthorityHistory(db, facts, signal);
  if (digest(history?.binding ?? null) !== digest(controller.history ?? null)) fail();
  if (history) metadata.push({ history: history.localDigest });
  const directories = resolveNativeHarnessPersistenceProfile(facts.execution).directories;
  const stat = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const rootStat = await stat(root);
  if (rootStat) {
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail();
    const names = await readdir(root);
    if (names.some(name => !isKnownNativeSessionRootEntry(name))) fail();
    if (names.some(name => ["runner", "codex-home", "opencode", "acpx"].includes(name)
      && !directories.some(directory => directory.name === name))) fail();
    const control = await stat(join(root, "control-plane"));
    if (control && (!control.isDirectory() || control.isSymbolicLink()
      || (await readdir(join(root, "control-plane"))).some(name => name !== "control-plane-state.json"))) fail();
    for (const name of ["continuity-breaks", "provider-artifacts", "failover-backups"]) {
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
  for (const directory of directories) {
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

async function preserveWebEvidence(db: Db, input: Scope & {
  source: OriginalHarnessVolumeCapability; storage: StorageService; signal: AbortSignal;
}) {
  const facts = await databaseFacts(db, input, false, true), history = await captureAuthorityHistory(db, facts, input.signal);
  const web = await captureWebEvidence(facts, input.signal);
  const controller = await preserveControllerEvidence(db, facts, input, history, web), bindings = { packages: [], versions: [] };
  const previous = facts.anchor.runnerProfileJson?.[KEY];
  if (previous != null) {
    if (!await hasValidNativeHarnessFilesystemIndependence(db, input)) fail();
    return { scopeDigest: input.scopeDigest, sourceRunId: facts.source.id, receiptDigest: digest(previous) };
  }
  const receipt: Receipt = { schema: WEB_SCHEMA, selectedSessionId: input.selectedSessionId, scopeDigest: input.scopeDigest,
    lastRunId: facts.anchor.id, sourceRunId: facts.source.id, factsDigest: facts.factsDigest,
    sourceCapabilityFingerprint: input.source.fingerprint, localFactsDigest: web.localDigest,
    assetsDigest: digest(bindings), ...bindings, controller, web: web.binding, observedAt: new Date().toISOString() };
  let published = receipt;
  const publications: ActivityPublication[] = [];
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`set local lock_timeout = '1s'`);
    const current = await databaseFacts(tx, input, true, true);
    if (current.factsDigest !== facts.factsDigest) fail();
    const currentController = await controllerBinding(tx, current, controller.archive, true, controller.history, web.binding);
    const currentWeb = await captureWebEvidence(current, input.signal);
    if (digest(currentController) !== digest(controller) || currentWeb.localDigest !== web.localDigest
      || digest(currentWeb.binding) !== digest(web.binding)) fail();
    await assertOriginalHarnessVolumeSource(input.source); input.signal.throwIfAborted();
    const existing = current.anchor.runnerProfileJson?.[KEY];
    if (existing != null) {
      const winner = matchingReceipt(existing, current, input, bindings, currentController, web.binding);
      if (!winner) fail(); published = winner; return;
    }
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...current.anchor.runnerProfileJson, [KEY]: receipt } })
      .where(and(eq(heartbeatRuns.id, current.anchor.id), eq(heartbeatRuns.companyId, input.companyId)));
    await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "native-harness-preservation",
      action: "native_harness_filesystem_independence_verified", entityType: "heartbeat_run", entityId: current.anchor.id,
      agentId: current.anchor.agentId, runId: current.anchor.id, details: { scopeDigest: input.scopeDigest, sourceRunId: current.source.id,
        sourceCapabilityFingerprint: receipt.sourceCapabilityFingerprint, factsDigest: receipt.factsDigest, coverage: "web_evidence" } }, publications);
  });
  for (const publication of publications) publishActivity(publication);
  return { scopeDigest: input.scopeDigest, sourceRunId: facts.source.id, receiptDigest: digest(published) };
}

export async function preserveNativeHarnessFilesystemIndependence(db: Db, input: Scope & {
  source: OriginalHarnessVolumeCapability; storage: StorageService; signal: AbortSignal; mode?: "web_evidence";
}) {
  await assertOriginalHarnessVolumeSource(input.source); input.signal.throwIfAborted();
  if (input.storage.provider !== "s3") fail();
  if (input.mode === "web_evidence") return preserveWebEvidence(db, input);
  const facts = await databaseFacts(db, input, false), assets = await assetBindings(db, facts.anchor, facts.source.id);
  const history = await captureAuthorityHistory(db, facts, input.signal);
  const controller = await preserveControllerEvidence(db, facts, input, history);
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
    const currentController = await controllerBinding(tx, current, controller.archive, true, controller.history);
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
