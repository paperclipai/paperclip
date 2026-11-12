import { and, eq, inArray, sql } from "drizzle-orm";
import { readEnvironmentResumeErrorDiagnostic } from "@paperclipai/plugin-sdk";
import type { Db } from "@paperclipai/db";
import { environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { EnvironmentLease } from "@paperclipai/shared";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { verifyRecoverableNativeHarnessBackup } from "./native-runtime/native-harness-backup-storage.js";
import { findPluginWorkerUnavailableError } from "./plugin-worker-unavailable-error.js";
import { sandboxProviderFailureLabel } from "./remote-workspace-transport.js";

/**
 * Total time one run spends resuming a preserved reusable sandbox, including
 * its in-run retries. A stopped Daytona sandbox resumes in seconds and an
 * archived one in under a minute, so this leaves headroom while keeping one
 * attempt from spending the provider's whole five-minute start deadline.
 */
export const REUSABLE_SANDBOX_RESUME_BUDGET_MS = 90_000;

/** Failure reason recorded on a preserved lease retired in favor of a replacement. */
export const REUSABLE_SANDBOX_RESUME_REPLACED_REASON = "resume_failed";

/**
 * A provider refused to start a sandbox because it is still changing state,
 * for example auto-stopping or archiving after an idle period. Waiting can
 * resolve it, so it is retried like a 5xx.
 */
export function sandboxStateTransitionFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    if (/state change in progress|\bis still [a-z_]+ at its start deadline\b/i.test(message)) return true;
  }
  return false;
}

/**
 * Decide whether a preserved reusable sandbox that could not be resumed may be
 * replaced.
 *
 * Replacement is safe only when nothing lives solely on that sandbox:
 * - its last run has ended (released or retained, and no live run holds it);
 * - the task workspace is clean and its saved version is a committed snapshot,
 *   so a new sandbox restores exactly the same files;
 * - a native runner session has a verified, lease-bound harness backup.
 * Anything else (unsaved work, a live owner, a legacy workspace with no saved
 * version, an access refusal) keeps the strict preserve-and-retry behavior.
 *
 * This only reads. The caller creates and records the replacement first, then
 * calls `retireReplacedReusableSandboxLease`, so a failed creation or a restart
 * in between leaves the preserved lease eligible for the next attempt.
 */
export async function reusableSandboxReplacementIsSafe(input: {
  db: Db;
  lease: EnvironmentLease;
  companyId: string;
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
  adapterType: string | null | undefined;
  cause: unknown;
}): Promise<boolean> {
  const { db, lease } = input;
  if (!input.heartbeatRunId || !lease.providerLeaseId || lease.companyId !== input.companyId) return false;
  if (lease.status !== "released" && lease.status !== "retained") return false;
  if (!input.executionWorkspaceId || lease.executionWorkspaceId !== input.executionWorkspaceId) return false;
  // A replacement cannot succeed where the resume was refused for access, and
  // an unavailable worker cannot create one either.
  if (findPluginWorkerUnavailableError(input.cause)) return false;
  const failure = sandboxProviderFailureLabel(input.cause);
  const status = failure.status ?? readEnvironmentResumeErrorDiagnostic(input.cause)?.httpStatus ?? null;
  if (failure.label === "provider_access_denied" || failure.label === "permission_denied"
    || status === 401 || status === 403) return false;
  // A run that still holds the sandbox may have work on it.
  if (lease.heartbeatRunId && lease.heartbeatRunId !== input.heartbeatRunId) {
    const [owner] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId)));
    if (owner && ["queued", "scheduled_retry", "running"].includes(owner.status)) return false;
  }

  const [workspace] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.executionWorkspaceId)));
  let authority: ReturnType<typeof readRemoteWorkspaceAuthority>;
  try {
    authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  } catch {
    return false;
  }
  if (!authority || authority.dirty || !authority.snapshotId) return false;
  if (authority.writerRunId !== null && authority.writerRunId !== input.heartbeatRunId) return false;
  if (authority.location && authority.location.providerLeaseId !== lease.providerLeaseId) return false;
  const [snapshot] = await db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, input.companyId),
    eq(executionWorkspaceSnapshots.executionWorkspaceId, input.executionWorkspaceId),
    eq(executionWorkspaceSnapshots.id, authority.snapshotId),
    eq(executionWorkspaceSnapshots.status, "committed"),
  ));
  if (!snapshot) return false;

  const scope = lease.metadata?.reusableSandboxLease as { adapterType?: unknown } | undefined;
  if ((input.adapterType === "paperclip_runner" || scope?.adapterType === "paperclip_runner")
    && !await verifyRecoverableNativeHarnessBackup({ db, companyId: lease.companyId,
      stamp: lease.metadata?.nativeHarnessBackup, providerLeaseId: lease.providerLeaseId })) return false;

  return true;
}

/**
 * Retire a preserved lease after its replacement lease is recorded. The old
 * sandbox is not destroyed here: a provider that cannot start it may also be
 * slow to delete it, and that must not delay this run's first turn. The
 * `pending_cleanup` row hands the destroy to the existing cleanup sweep. The
 * write is guarded, so a lease that another run resumed meanwhile is untouched.
 */
export async function retireReplacedReusableSandboxLease(input: {
  db: Db;
  lease: EnvironmentLease;
  companyId: string;
  heartbeatRunId: string;
}): Promise<boolean> {
  const { db, lease } = input;
  if (!lease.providerLeaseId) return false;
  const now = new Date();
  const [claimed] = await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
    status: "pending_cleanup",
    cleanupStatus: "failed",
    failureReason: REUSABLE_SANDBOX_RESUME_REPLACED_REASON,
    releasedAt: now,
    lastUsedAt: now,
    updatedAt: now,
  }).where(and(
    eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    inArray(environmentLeases.status, ["released", "retained"]),
    sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') != 'true'`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.id} = ${environmentLeases.heartbeatRunId}
        AND ${heartbeatRuns.id} <> ${input.heartbeatRunId}
        AND ${heartbeatRuns.status} IN ('queued', 'scheduled_retry', 'running')
    )`,
  )).returning({ id: environmentLeases.id }), { companyId: input.companyId, runId: lease.heartbeatRunId ?? undefined });
  return Boolean(claimed);
}
