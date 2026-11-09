import { and, eq, sql } from "drizzle-orm";
import {
  executionWorkspaceRepositories, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, nativeRunnerCheckpoints,
  nativeRunResults, workspaceOperations, type Db,
} from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { runOwnerFenceHeldSql } from "./remote-workspace-writer-hold.js";

/**
 * A writer's prepared files equal its saved version only while nothing ran in
 * them. Preparation records that starting point; everything after it leaves a
 * durable record (an operation, a runner checkpoint, a run event or a
 * process) before it can write. A run with none of those changed nothing.
 */
export const UNCHANGED_BASELINE_KEY = "remoteWorkspaceUnchangedBaseline";
export const UNCHANGED_BASELINE_SCHEMA = "paperclip.remote-workspace-unchanged-baseline.v1";

export type UnchangedBaseline = {
  schema: typeof UNCHANGED_BASELINE_SCHEMA; epoch: number; runId: string; snapshotId: string;
  /** Set once the writer was released without a new save. */
  releasedAt?: string;
};

type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "metadata">;
type Repository = { id: string; relativePath: string; repoUrl: string; ref: string | null; pinnedCommit?: string };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Missing or malformed fields (an older or partial record) never prove anything. */
export function readUnchangedBaseline(metadata: Record<string, unknown> | null | undefined): UnchangedBaseline | null {
  const value = object(metadata?.[UNCHANGED_BASELINE_KEY]);
  if (value.schema !== UNCHANGED_BASELINE_SCHEMA || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
    || typeof value.runId !== "string" || !value.runId || typeof value.snapshotId !== "string" || !value.snapshotId
    || (value.releasedAt !== undefined && typeof value.releasedAt !== "string")) return null;
  return value as UnchangedBaseline;
}

/** Operations that cannot change the saved files: a restore writes exactly the
 * saved version, and finalize and recovery rows are receipts that wrap a save
 * (whose own snapshot operation is still counted). */
const FILE_NEUTRAL_OPERATION_PHASES = ["remote_workspace_restore", "workspace_finalize", "workspace_recovery"];
/** Terminal states of a run that ended without a result. */
const ENDED_WITHOUT_RESULT = ["failed", "cancelled", "interrupted", "timed_out"];

export type UnchangedProofRefusal =
  | "baseline_missing" | "authority_mismatch" | "writer_not_ended" | "writer_owner_live" | "process_recorded"
  | "reference_mismatch" | "provider_session_started" | "execution_recorded" | "result_recorded"
  | "runner_commanded" | "workspace_operation_recorded" | "repository_unsaved";

/**
 * Whether the ended writer of `authority` provably left its files exactly as
 * the saved version it started from. The caller holds the workspace row lock.
 * Any missing, ambiguous or older-release evidence refuses; a refusal keeps
 * today's full save.
 */
export async function proveRemoteWorkspaceUnchanged(tx: Pick<Db, "select">, input: {
  workspace: Workspace; authority: RemoteWorkspaceAuthority;
  /** The caller owns the writer's finalization, so its own fence is expected. */
  callerOwnsWriter?: boolean;
  isSavedRepository: (repository: Repository) => boolean;
}): Promise<{ proven: true; baseline: UnchangedBaseline } | { proven: false; reason: UnchangedProofRefusal }> {
  const { workspace, authority } = input;
  const runId = authority.writerRunId;
  const baseline = readUnchangedBaseline(workspace.metadata);
  if (!baseline || baseline.releasedAt || !runId || baseline.runId !== runId) return { proven: false, reason: "baseline_missing" };
  if (!authority.dirty || !authority.location || authority.epoch !== baseline.epoch || authority.snapshotId !== baseline.snapshotId)
    return { proven: false, reason: "authority_mismatch" };

  const [run] = await tx.select({ status: heartbeatRuns.status, processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
    sessionIdAfter: heartbeatRuns.sessionIdAfter, runnerProfileJson: heartbeatRuns.runnerProfileJson,
    ownerFenceHeld: runOwnerFenceHeldSql() }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, runId)));
  if (!run || !ENDED_WITHOUT_RESULT.includes(run.status)) return { proven: false, reason: "writer_not_ended" };
  if (!input.callerOwnsWriter && run.ownerFenceHeld) return { proven: false, reason: "writer_owner_live" };
  if (run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null || run.sessionIdAfter !== null)
    return { proven: false, reason: "process_recorded" };
  const profile = object(run.runnerProfileJson);
  const reference = remoteWorkspaceRunReferenceSchema.safeParse(profile.remoteWorkspace);
  if (profile.nativeWorkspaceSync != null || !reference.success || reference.data.state !== "prepared"
    || reference.data.workspaceId !== workspace.id || reference.data.epoch !== authority.epoch
    || reference.data.snapshotId !== authority.snapshotId || reference.data.leaseId !== authority.location.leaseId
    || reference.data.remoteCwd !== authority.location.remoteCwd) return { proven: false, reason: "reference_mismatch" };
  // A rebound admission checkpoint may name this run; it proves nothing ran
  // only while it holds no turn, result or terminal state of its own.
  const checkpoint = object(profile.sessionCheckpoint);
  if (object(checkpoint.identity).runId === runId && (checkpoint.activeTurnId != null || checkpoint.semanticResult != null
    || checkpoint.terminal != null || (checkpoint.terminalTurns != null
      && (!Array.isArray(checkpoint.terminalTurns) || checkpoint.terminalTurns.length > 0))))
    return { proven: false, reason: "provider_session_started" };

  const [event] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, workspace.companyId), eq(heartbeatRunEvents.runId, runId),
    executionStartedEventPredicate())).limit(1);
  if (event) return { proven: false, reason: "execution_recorded" };
  const [result] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, workspace.companyId), eq(nativeRunResults.runId, runId))).limit(1);
  if (result) return { proven: false, reason: "result_recorded" };
  // The controller writes this checkpoint before every runner command.
  const [commanded] = await tx.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, workspace.companyId), eq(nativeRunnerCheckpoints.runId, runId))).limit(1);
  if (commanded) return { proven: false, reason: "runner_commanded" };
  // Provisioning and saves record their operation before they touch files.
  const [operation] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.heartbeatRunId, runId),
    sql`(${workspaceOperations.executionWorkspaceId} is null or ${workspaceOperations.executionWorkspaceId} = ${workspace.id})`,
    sql`${workspaceOperations.phase} not in (${sql.join(FILE_NEUTRAL_OPERATION_PHASES.map(phase => sql`${phase}`), sql`, `)})`)).limit(1);
  if (operation) return { proven: false, reason: "workspace_operation_recorded" };
  // A requested repository is cloned before its save is recorded. Only
  // repositories already in the saved version are proven untouched.
  const repositories = await tx.select().from(executionWorkspaceRepositories).where(and(
    eq(executionWorkspaceRepositories.companyId, workspace.companyId),
    eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id)));
  if (repositories.some(row => !row.pinnedCommit || !input.isSavedRepository({ id: row.id, relativePath: row.relativePath,
    repoUrl: row.repoUrl, ref: row.requestedRef === "HEAD" ? null : row.requestedRef, pinnedCommit: row.pinnedCommit })))
    return { proven: false, reason: "repository_unsaved" };
  return { proven: true, baseline };
}
