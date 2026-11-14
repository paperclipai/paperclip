import { and, eq, inArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentTaskSessions, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { readLegacyNativeControllerArchiveDigests, readLegacyNativeControllerArchiveSource } from "./native-controller-migration.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import { archiveFailedLegacyNativeController } from "./native-controller-archive.js";
import type { StorageService } from "../../storage/types.js";
import { assertOriginalHarnessVolumeSource, type OriginalHarnessVolumeCapability } from "./native-harness-original-volume.js";

export type SettledControllerArchiveOwner = {
  kind: "settled_controller_archive";
  companyId: string; issueId: string; agentId: string; runId: string; sessionId: string;
  selectedSessionId: string; selectedLastRunId: string;
  profileDigest: string; coordinatorDigest: string; controllerDigest: string | null; supervisorDigest: string | null;
  filesystemIndependence?: { source: OriginalHarnessVolumeCapability; scopeDigest: string; factsDigest: string };
};
const fileDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export function nativeControllerArchiveProfileDigest(value: unknown) {
  const profile = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return nativeSha256({ nativeExecutionInput: profile.nativeExecutionInput ?? null, nativeToolContractFingerprint: profile.nativeToolContractFingerprint ?? null,
    sessionCheckpoint: profile.sessionCheckpoint ?? null, nativeControllerRecovery: profile.nativeControllerRecovery ?? null });
}

export function nativeControllerArchiveCoordinatorDigest(value: {
  phase: string; resultId: string | null; controllerBootId: string | null; controllerGeneration: number; recoveryState: unknown;
}) {
  return nativeSha256({ phase: value.phase, resultId: value.resultId, controllerBootId: value.controllerBootId,
    controllerGeneration: value.controllerGeneration, recoveryState: value.recoveryState });
}

export async function assertSettledControllerArchiveSource(db: Db, owner: SettledControllerArchiveOwner) {
  function fail(): never { throw new Error("native_controller_archive_source_unsettled"); }
  if (owner.controllerDigest === null && !owner.filesystemIndependence) fail();
  if (owner.filesystemIndependence) {
    await assertOriginalHarnessVolumeSource(owner.filesystemIndependence.source);
    await (await import("./native-harness-filesystem-independence.js")).assertNativeHarnessFilesystemArchiveSource(db, owner);
  }
  await db.execute(sql`set local lock_timeout = '1s'`);
  if (!await tryLockNativeWorkspaceFinalization(db, owner)) fail();
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId))).for("update");
  if (!task || task.executionRunId || task.checkoutRunId) fail();
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, owner.companyId), eq(nativeRunFinalizations.issueId, owner.issueId),
    eq(nativeRunFinalizations.runId, owner.runId))).for("update");
  if (!coordinator || coordinator.leaseOwner || coordinator.nextAttemptAt
    || !(coordinator.phase === "terminal_failure" || coordinator.phase === "committed" && coordinator.resultId)
    || nativeControllerArchiveCoordinatorDigest(coordinator) !== owner.coordinatorDigest) fail();
  const [selection] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id, owner.selectedSessionId),
    eq(agentTaskSessions.companyId, owner.companyId), eq(agentTaskSessions.agentId, owner.agentId),
    eq(agentTaskSessions.lastRunId, owner.selectedLastRunId))).for("share");
  const [selectedRun] = await db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, owner.selectedLastRunId), eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.agentId, owner.agentId),
    eq(heartbeatRuns.nativeIssueId, owner.issueId), eq(heartbeatRuns.nativeSessionId, owner.sessionId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, owner.runId),
    eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.agentId, owner.agentId), eq(heartbeatRuns.nativeIssueId, owner.issueId),
    eq(heartbeatRuns.nativeSessionId, owner.sessionId), eq(heartbeatRuns.runtimeMode, "native"))).for("share");
  if (!selection || !selectedRun || !run?.finishedAt
    || (owner.filesystemIndependence ? !["failed", "succeeded"].includes(run.status)
      || run.status === "succeeded" && (coordinator.phase !== "committed" || !coordinator.resultId) : run.status !== "failed")
    || nativeControllerArchiveProfileDigest(run.runnerProfileJson) !== owner.profileDigest) fail();
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, owner.companyId),
    inArray(heartbeatRuns.status, ["queued", "running"]), or(eq(heartbeatRuns.nativeIssueId, owner.issueId),
      eq(heartbeatRuns.issueId, owner.issueId), eq(heartbeatRuns.nativeSessionId, owner.sessionId)))).limit(1);
  if (active) fail();
  const selected = await findNativeSessionResumeRun(db, { companyId: owner.companyId, agentId: owner.agentId, issueId: owner.issueId,
    normalizedSessionId: owner.sessionId, beforeCreatedAt: selectedRun.createdAt, includeProgressBarrier: true });
  if (!selected || selected.id !== owner.runId || nativeControllerArchiveProfileDigest(selected.runnerProfileJson) !== owner.profileDigest) fail();
  const material = await readLegacyNativeControllerArchiveDigests(selected);
  if ((material.controllerDigest ?? null) !== owner.controllerDigest
    || (material.supervisorDigest ?? null) !== owner.supervisorDigest) fail();
}

export async function archiveSettledFailedNativeController(db: Db, input: {
  selected: { id: string; lastRunId: string; companyId: string; agentId: string; issueId: string; sessionId: string };
  source: NonNullable<Awaited<ReturnType<typeof findNativeSessionResumeRun>>>;
  storage: StorageService; signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const { selected, source } = input;
  const material = await readLegacyNativeControllerArchiveSource(source);
  if (material.controller === undefined) return "source_already_absent" as const;
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, selected.companyId),
    eq(nativeRunFinalizations.issueId, selected.issueId), eq(nativeRunFinalizations.runId, source.id)));
  if (!coordinator) throw new Error("native_controller_archive_source_unsettled");
  const owner: SettledControllerArchiveOwner = { kind: "settled_controller_archive", companyId: selected.companyId,
    issueId: selected.issueId, agentId: selected.agentId, runId: source.id, sessionId: selected.sessionId,
    selectedSessionId: selected.id, selectedLastRunId: selected.lastRunId,
    profileDigest: nativeControllerArchiveProfileDigest(source.runnerProfileJson), coordinatorDigest: nativeControllerArchiveCoordinatorDigest(coordinator),
    controllerDigest: fileDigest(material.controller), supervisorDigest: material.supervisor === undefined ? null : fileDigest(material.supervisor) };
  await db.transaction(tx => assertSettledControllerArchiveSource(tx as unknown as Db, owner));
  input.signal.throwIfAborted();
  await archiveFailedLegacyNativeController(db, { companyId: selected.companyId, issueId: selected.issueId, runId: source.id,
    controller: material.controller, supervisor: material.supervisor, storage: input.storage, onlineOwner: owner, signal: input.signal });
  return "archived_failed" as const;
}
