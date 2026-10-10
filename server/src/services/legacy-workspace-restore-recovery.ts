import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure, WORKSPACE_RESTORE_FAILURE_CODES } from "@paperclipai/shared";
import { hasConfirmedSandboxStopAndRetain, prepareSandboxStopAndRetain } from "./sandbox-stop-and-retain.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;
/** The host's realized lease snapshot from before adapter execution. Never
 * reconstruct this identity from a terminal status or a search of old leases. */
export type LegacyWorkspaceRestoreSource = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "environmentId" | "issueId" | "executionWorkspaceId"
  | "provider" | "providerLeaseId" | "acquiredAt" | "leasePolicy" | "metadata">;

function needsRemoteRestore(run: Run): boolean {
  return run.runtimeMode === "legacy" && ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
    && hasWorkspaceRestoreFailure(run.resultJson);
}

function leaseScope(run: Run, source?: LegacyWorkspaceRestoreSource) {
  return and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    or(eq(environmentLeases.status, "active"), and(
      sql`${environmentLeases.metadata}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
      sql`${environmentLeases.metadata}->'workspaceRestoreRecovery'->>'runId' = ${run.id}`),
      source ? and(eq(environmentLeases.id, source.id), eq(environmentLeases.status, "released")) : undefined),
    isNotNull(environmentLeases.providerLeaseId),
    isNotNull(environmentLeases.provider), ne(environmentLeases.provider, "local"),
    or(eq(environments.driver, "sandbox"), sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
      sql`${environmentLeases.metadata}->>'sandboxProviderPlugin' = 'true'`));
}

function matchesOriginalSource(lease: typeof environmentLeases.$inferSelect, run: Run, source: LegacyWorkspaceRestoreSource) {
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? null;
  const workspaceId = run.contextSnapshot?.executionWorkspaceId;
  const remoteCwd = source.metadata?.remoteCwd;
  const realization = source.metadata?.workspaceRealization;
  if (typeof remoteCwd !== "string" || !remoteCwd.trim()
    || (typeof workspaceId === "string" && source.executionWorkspaceId !== workspaceId)) return false;
  if (realization !== undefined && realization !== null) {
    if (typeof realization !== "object" || Array.isArray(realization)) return false;
    const root = (realization as Record<string, unknown>).authoritativeRoot;
    if (root !== undefined && (typeof root !== "string" || !root.trim())) return false;
  }
  return source.leasePolicy === "ephemeral"
    && lease.leasePolicy === source.leasePolicy
    && source.companyId === run.companyId && source.heartbeatRunId === run.id && source.issueId === issueId
    && (["id", "companyId", "heartbeatRunId", "environmentId", "issueId", "executionWorkspaceId", "provider", "providerLeaseId"] as const)
      .every(key => lease[key] === source[key])
    && lease.acquiredAt.getTime() === source.acquiredAt.getTime()
    && (["pluginId", "sandboxProviderPlugin", "remoteCwd", "workspaceRealization"] as const)
      .every(key => isDeepStrictEqual(lease.metadata?.[key], source.metadata?.[key]));
}

/** A local lock timeout has no remote source to retain and keeps its old policy. */
export async function hasUnrestoredRemoteWorkspace(db: Db, run: Run): Promise<boolean> {
  if (!needsRemoteRestore(run)) return false;
  if (hasRequiredWorkspaceRecovery(run.resultJson)) return true;
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId)).where(leaseScope(run)).limit(1);
  return !!lease;
}

/** Call in the terminal-status transaction. No cleanup worker may observe the
 * failed run without its exact stop-only intent. The original allocation must
 * not enter warm reuse; it belongs to the board's workspace repair action. */
export async function preserveLegacyWorkspaceRestoreSources(db: Db, run: Run, source?: LegacyWorkspaceRestoreSource): Promise<string[]> {
  if (!needsRemoteRestore(run)) return [];
  const rows = await db.select({ lease: environmentLeases }).from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(leaseScope(run, source)).for("update", { of: environmentLeases });
  const retained: string[] = [];
  for (const { lease } of rows) {
    if (lease.status !== "active") {
      const recovery = lease.metadata?.workspaceRestoreRecovery as Record<string, unknown> | undefined;
      if (recovery?.schema === LEGACY_WORKSPACE_RECOVERY_SCHEMA && recovery.runId === run.id) {
        retained.push(lease.id); continue;
      }
      // Cancellation can finish the dedicated stop before copy-back reports its
      // failure. Only the host's original source and two matching receipts can
      // turn that released row into a file-repair hold.
      if (!source || !matchesOriginalSource(lease, run, source) || !hasConfirmedSandboxStopAndRetain(lease)) continue;
      const others = await db.select().from(environmentLeases).where(and(
        ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
      ));
      // A later owner invalidates this stop even if it has since stopped too.
      // Cross-company owners also fail closed without exposing their identity.
      if (others.some(other => other.acquiredAt >= lease.acquiredAt || !hasRemoteTerminationReceipt(other))) continue;
      await db.update(environmentLeases).set({ leasePolicy: "retain_on_failure",
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ workspaceRestoreRecovery: {
          schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, runId: run.id,
        } })}::jsonb`,
      }).where(eq(environmentLeases.id, lease.id));
      // Reusable sources are excluded: provider resume precedes the database
      // handoff, so a row lock cannot fence an in-flight resume. Keep the release
      // status and receipts; this repair hold grants no execute right.
      retained.push(lease.id); continue;
    }
    // The stop-only worker rechecks exact allocation ownership, including
    // competing leases, before dispatch. Persist the intent even when cleanup
    // must wait, so no terminal-run sweep can fall back to destruction.
    const prepared = await prepareSandboxStopAndRetain(db, lease);
    if (!prepared) throw new Error("Workspace recovery lease ownership changed before terminal commit.");
    await db.update(environmentLeases).set({ leasePolicy: "retain_on_failure",
      metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ workspaceRestoreRecovery: {
        schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, runId: run.id,
      } })}::jsonb`,
    }).where(and(
      eq(environmentLeases.id, prepared.id), eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.status, "pending_cleanup"),
    ));
    retained.push(lease.id);
  }
  return retained;
}

/** Metadata writers may use safe projections or snapshots from before copy-back
 * settled. Only the restore recorder owns these fields; preserve their current
 * database values rather than a stale or schema-only incoming projection. */
export function preserveWorkspaceRestoreRecoveryMetadataSql(
  incoming: Record<string, unknown> | null,
  mergeCurrent = false,
) {
  const payload = sql`${JSON.stringify(incoming)}::jsonb`;
  const result = mergeCurrent
    ? sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || coalesce(nullif(${payload}, 'null'::jsonb), '{}'::jsonb)`
    : payload;
  return sql`case when
    ${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    and ${inArray(sql`${heartbeatRuns.resultJson}->>'workspaceRestoreFailure'`, [...WORKSPACE_RESTORE_FAILURE_CODES])}
    then coalesce(nullif(${result}, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(
      'workspaceRestoreFailure', ${heartbeatRuns.resultJson}->'workspaceRestoreFailure',
      'workspaceRestoreRecovery', ${heartbeatRuns.resultJson}->'workspaceRestoreRecovery')
    else ${result} end`;
}
