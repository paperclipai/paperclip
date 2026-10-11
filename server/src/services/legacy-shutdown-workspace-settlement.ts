import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

const SCHEMA = "paperclip.legacy-shutdown-workspace-settlement.v1";
type Lease = Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "metadata">;
type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

export function pendingLegacyShutdownWorkspaceSettlement(lease: Lease) {
  const value = lease.metadata?.legacyShutdownWorkspaceSettlement;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  return marker.schema === SCHEMA && marker.state === "pending" && marker.runId === lease.heartbeatRunId
    && typeof marker.deadlineAt === "string" ? marker : null;
}

/** Historical reuse rows may name the same allocation as the fenced source. */
export async function legacyShutdownWorkspaceResourceProtected(db: Db,
  lease: Pick<typeof environmentLeases.$inferSelect, "provider" | "providerLeaseId">) {
  if (!lease.provider || !lease.providerLeaseId) return false;
  const [protectedLease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
    or(sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'schema' = ${SCHEMA}
      and ${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'state' = 'pending'`,
      sql`${environmentLeases.metadata}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`),
  )).limit(1);
  return !!protectedLease;
}

/** Released stop receipts still need reconciliation if export never settled. */
export async function sweepLegacyShutdownWorkspaceSettlements(db: Db, now = new Date()) {
  const rows = await db.select().from(environmentLeases).where(and(
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'schema' = ${SCHEMA}`,
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'state' = 'pending'`,
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'deadlineAt' <= ${now.toISOString()}`,
  )).orderBy(sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'deadlineAt'`).limit(50);
  for (const lease of rows) await allowLegacyShutdownWorkspaceCleanup(db, lease, now);
}

/** Commit the fence while the run is still live, before exposing interruption. */
export async function beginLegacyShutdownWorkspaceSettlement(db: Db, run: Run, deadlineAt: Date) {
  await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) ||
    ${JSON.stringify({ legacyShutdownWorkspaceSettlement: { schema: SCHEMA, state: "pending", runId: run.id,
      controllerBootId: legacyControllerBootId, deadlineAt: deadlineAt.toISOString() } })}::jsonb`,
  }).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    eq(environmentLeases.status, "active"), ne(environmentLeases.provider, "local"),
    or(sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`, sql`${environmentLeases.metadata}->>'sandboxProviderPlugin' = 'true'`)));
}

/** The owner joins settlement, or records exact retention before timeout cleanup. */
export async function finishLegacyShutdownWorkspaceSettlement(db: Db, run: Run, state: "settled" | "expired" = "settled") {
  await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata},
    '{legacyShutdownWorkspaceSettlement,state}', ${JSON.stringify(state)}::jsonb)` }).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'schema' = ${SCHEMA}`,
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'controllerBootId' = ${legacyControllerBootId}`,
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement'->>'state' = 'pending'`,
  ));
}

/** A restart or another cleanup worker must never infer saved files from timeout. */
export async function allowLegacyShutdownWorkspaceCleanup(db: Db, lease: Lease, now = new Date(),
  options: { ownerStopOnly?: boolean } = {}) {
  if (!pendingLegacyShutdownWorkspaceSettlement(lease)) return true;
  return db.transaction(async tx => {
    const [hint] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!),
    ));
    if (!hint) return false;
    if (!pendingLegacyShutdownWorkspaceSettlement(hint)) return true;
    // Match the terminal recorder's issue -> run -> lease lock order. Settlement
    // and expiry compete on the current lease row, not the caller's old snapshot.
    if (hint.issueId) await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, hint.issueId), eq(issues.companyId, lease.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId!),
      eq(heartbeatRuns.runtimeMode, "legacy"),
    )).for("update");
    const [current] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!),
    )).for("update");
    if (!run || !current) return false;
    const marker = pendingLegacyShutdownWorkspaceSettlement(current);
    if (!marker) return true;
    // Stopping and retaining the exact owner's command is a prerequisite for
    // some adapters to settle. This exception never permits provider destruction.
    if (options.ownerStopOnly && marker.controllerBootId === legacyControllerBootId
      && adapterExecutionControls.get(run.id)?.controller.signal.aborted) return true;
    const deadline = Date.parse(marker.deadlineAt as string);
    if (!Number.isFinite(deadline) || deadline > now.getTime()) return false;
    // A killed container cannot certify export. Preserve source and hold in
    // this same transaction before any worker may perform provider cleanup.
    if (current.status !== "active") {
      const { hasConfirmedSandboxStopAndRetain, readStopOnlyCleanup } = await import("./sandbox-stop-and-retain.js");
      if (!(current.status === "released" && hasConfirmedSandboxStopAndRetain(current))
        && !(current.status === "pending_cleanup" && readStopOnlyCleanup(current))) return false;
      // The shutdown marker was committed on this exact active source before
      // cancellation. A stop receipt does not certify the later file export.
      const [competing] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
        ne(environmentLeases.id, current.id), eq(environmentLeases.provider, current.provider!),
        eq(environmentLeases.providerLeaseId, current.providerLeaseId!),
        or(inArray(environmentLeases.status, ["active", "pending_cleanup"]),
          gt(environmentLeases.acquiredAt, current.acquiredAt)),
      )).limit(1);
      if (competing) return false;
      await tx.update(environmentLeases).set({ leasePolicy: "retain_on_failure",
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ workspaceRestoreRecovery: {
          schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, runId: run.id,
        } })}::jsonb`,
      }).where(eq(environmentLeases.id, current.id));
    }
    const { terminalizeLegacyExecution } = await import("./legacy-execution-recovery.js");
    const preserved = await terminalizeLegacyExecution({ db: tx as unknown as Db, run, status: run.status,
      recordRestoreFailureOnly: true, patch: { resultJson: { workspaceRestoreFailure: "restore_failed" } } });
    if (!preserved) return false;
    await tx.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata},
      '{legacyShutdownWorkspaceSettlement,state}', '"expired"'::jsonb)` }).where(and(
      eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.heartbeatRunId, run.id),
    ));
    return true;
  });
}
