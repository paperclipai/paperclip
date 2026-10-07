import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { environmentLeases, environments, type heartbeatRuns, type Db } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { prepareSandboxStopAndRetain } from "./sandbox-stop-and-retain.js";

import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;

function needsRemoteRestore(run: Run): boolean {
  return run.runtimeMode === "legacy" && ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
    && hasWorkspaceRestoreFailure(run.resultJson);
}

function leaseScope(run: Run) {
  return and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    or(eq(environmentLeases.status, "active"), and(
      sql`${environmentLeases.metadata}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
      sql`${environmentLeases.metadata}->'workspaceRestoreRecovery'->>'runId' = ${run.id}`)),
    isNotNull(environmentLeases.providerLeaseId),
    isNotNull(environmentLeases.provider), ne(environmentLeases.provider, "local"),
    or(eq(environments.driver, "sandbox"), sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
      sql`${environmentLeases.metadata}->>'sandboxProviderPlugin' = 'true'`));
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
export async function preserveLegacyWorkspaceRestoreSources(db: Db, run: Run): Promise<string[]> {
  if (!needsRemoteRestore(run)) return [];
  const rows = await db.select({ lease: environmentLeases }).from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(leaseScope(run)).for("update", { of: environmentLeases });
  const retained: string[] = [];
  for (const { lease } of rows) {
    if (lease.status !== "active") { retained.push(lease.id); continue; }
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
