import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { hasNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { nativeSessionProviderEvidence } from "./native-session-resume.js";
import { hasNativeExecutionStartEvidence } from "./native-restart-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { logger } from "../../middleware/logger.js";

/**
 * A continuation run starts with its predecessor's saved provider session and,
 * for a warm session, the predecessor's runner process identity. When such a
 * run fails before it ever asks for its own runner (for example while staging
 * its provider pack), the recorded process identity is the predecessor's, not
 * its own. A due same-run retry used to reattach to "this run's" runner, which
 * never existed, and always failed with `native_remote_recovery_lease_mismatch`.
 *
 * This module proves that shape from durable state and retires the inherited
 * identity, so the retry takes the ordinary same-run resume: the same path the
 * failed attempt took. It also records the run's own retained sandbox lease,
 * so preparation resumes that exact sandbox instead of acquiring another one.
 */
export const NATIVE_INHERITED_RUNNER_RETIREMENT_KEY = "nativeInheritedRunnerRetirement";
const RETIREMENT_SCHEMA = "paperclip.native-inherited-runner-retirement.v1";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export type InheritedRunnerRetainedSandbox = { leaseId: string; providerLeaseId: string; remoteCwd: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameTime(left: Date | null, right: Date | null) {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

/** The run's saved remote location: a native workspace sync or a remote workspace reference. */
function savedRemoteLocation(profile: Record<string, unknown>): InheritedRunnerRetainedSandbox | null {
  const sync = readNativeWorkspaceSyncReference(profile.nativeWorkspaceSync);
  if (sync) return { leaseId: sync.leaseId, providerLeaseId: sync.providerLeaseId, remoteCwd: sync.remoteCwd };
  const remote = remoteWorkspaceRunReferenceSchema.safeParse(profile.remoteWorkspace);
  return remote.success
    ? { leaseId: remote.data.leaseId, providerLeaseId: remote.data.providerLeaseId, remoteCwd: remote.data.remoteCwd }
    : null;
}

/** The retained sandbox recorded when the inherited identity was retired, if it still matches the saved location. */
export function readInheritedRunnerRetainedSandbox(profile: Record<string, unknown> | null | undefined): InheritedRunnerRetainedSandbox | null {
  const marker = record(profile?.[NATIVE_INHERITED_RUNNER_RETIREMENT_KEY]);
  const sandbox = record(marker.retainedSandbox);
  const location = savedRemoteLocation(record(profile));
  if (marker.schema !== RETIREMENT_SCHEMA || !location || sandbox.leaseId !== location.leaseId
    || sandbox.providerLeaseId !== location.providerLeaseId || sandbox.remoteCwd !== location.remoteCwd) return null;
  return location;
}

/**
 * Retires the inherited remote runner identity of a due same-run retry when
 * durable state proves all of these:
 *
 * - the failed attempt is a result-less exact-checkpoint retry that recorded
 *   `providerEventsExist: false`, and no controller owns it;
 * - this run never requested or identified a runner, invoked the adapter,
 *   started a tool, or committed a runner event, has no controller checkpoint
 *   of its own, and has no provider event or provider session of its own;
 * - its saved session has no active turn and no pending runtime request; and
 * - its exact process identity is the one a settled predecessor of the same
 *   native session recorded.
 *
 * Anything else, including rows saved by a release that did not record these
 * facts, keeps the existing verified reattachment path.
 */
export type InheritedRunnerRetirement = "retired" | "not_applicable" | "transient";

export async function retireInheritedRemoteRunnerIdentity(db: Db, runId: string): Promise<InheritedRunnerRetirement> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select set_config('lock_timeout', '2000', true)`);
    const [candidate] = await tx.select({ companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.nativeIssueId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
    if (!candidate?.issueId) return "not_applicable";
    // Same lock order as same-run resumption: issue, coordinator, run.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId))).for("update").limit(1);
    if (!issue) return "not_applicable";
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, runId),
      eq(nativeRunFinalizations.issueId, issue.id))).for("update").limit(1);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, runId))).for("update").limit(1);
    // A concurrent sweep already retired it: route it to the same resume.
    if (coordinator && run && run.processPid === null && run.processGroupId === null
      && record(record(run.runnerProfileJson)[NATIVE_INHERITED_RUNNER_RETIREMENT_KEY]).schema === RETIREMENT_SCHEMA
      && coordinator.phase === "retryable_failure" && coordinator.resultId === null) return "retired";
    if (!coordinator || !run || run.runtimeMode !== "native" || isNativeRunnerOwnershipHeld(run)
      || !["running", "failed"].includes(run.status) || run.sessionIdAfter
      || (run.processPid === null && run.processGroupId === null) || !run.nativeSessionId) return "not_applicable";
    const detail = record(coordinator.failureDetail);
    if (coordinator.phase !== "retryable_failure" || coordinator.resultId !== null || coordinator.leaseOwner !== null
      || detail.recoveryMode !== "exact_checkpoint_resume" || detail.providerEventsExist !== false
      || typeof detail.successorRunId === "string") return "not_applicable";

    const profile = record(run.runnerProfileJson);
    const location = savedRemoteLocation(profile);
    const checkpoint = record(profile.sessionCheckpoint);
    const pending = checkpoint.pendingRuntimeRequests;
    if (!location || checkpoint.activeTurnId != null
      || (pending !== undefined && pending !== null && (!Array.isArray(pending) || pending.length > 0))) return "not_applicable";
    if (await hasNativeExecutionStartEvidence(tx, run)) return "not_applicable";
    if ((await nativeSessionProviderEvidence(tx, [run.id])).has(run.id)) return "not_applicable";
    if (await hasNativeRunnerCheckpoint(tx, { companyId: run.companyId, issueId: issue.id, runId: run.id })) return "not_applicable";

    // The identity must be exactly the one a settled predecessor recorded.
    const [predecessor] = await tx.select({ id: heartbeatRuns.id, processStartedAt: heartbeatRuns.processStartedAt })
      .from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
      eq(heartbeatRuns.nativeSessionId, run.nativeSessionId), ne(heartbeatRuns.id, run.id),
      lt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
      run.processPid === null ? isNull(heartbeatRuns.processPid) : eq(heartbeatRuns.processPid, run.processPid),
      run.processGroupId === null ? isNull(heartbeatRuns.processGroupId) : eq(heartbeatRuns.processGroupId, run.processGroupId),
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if (!predecessor || !sameTime(predecessor.processStartedAt, run.processStartedAt)) return "not_applicable";

    // Keep the run's own sandbox when its lease is still live.
    const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, location.leaseId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, location.providerLeaseId),
      eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt), isNull(environmentLeases.cleanupStatus),
      or(isNull(environmentLeases.expiresAt), sql`${environmentLeases.expiresAt} > now()`))).limit(1);

    await notifyLiveRunRecovery(tx, { companyId: run.companyId, runId: run.id, agentId: run.agentId });
    await tx.update(heartbeatRuns).set({
      processPid: null, processGroupId: null, processStartedAt: null,
      runnerProfileJson: { ...profile, [NATIVE_INHERITED_RUNNER_RETIREMENT_KEY]: {
        schema: RETIREMENT_SCHEMA, predecessorRunId: predecessor.id,
        ...(lease ? { retainedSandbox: location } : {}),
      } },
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    await appendHeartbeatRunEvent(tx, {
      companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "lifecycle", stream: "system", level: "info",
      message: "Retrying this run in its own sandbox: it never started a runner, so there was nothing to reattach to.",
      payload: { reason: "inherited_runner_never_launched", predecessorRunId: predecessor.id,
        retainedSandbox: Boolean(lease) },
    });
    return "retired" as const;
  }).catch((error): InheritedRunnerRetirement => {
    // A busy lock or a database error proves nothing. Keep the run for the next sweep.
    logger.warn({ err: error, runId }, "failed to retire an inherited remote runner identity");
    return "transient";
  });
}
