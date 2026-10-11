import { and, eq, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

const SCHEMA = "paperclip.legacy-shutdown-workspace-settlement.v1";
type Lease = Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "metadata">;
type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

function pending(lease: Lease) {
  const value = lease.metadata?.legacyShutdownWorkspaceSettlement;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  return marker.schema === SCHEMA && marker.state === "pending" && marker.runId === lease.heartbeatRunId
    && typeof marker.deadlineAt === "string" ? marker : null;
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
export async function allowLegacyShutdownWorkspaceCleanup(db: Db, lease: Lease, now = new Date()) {
  const marker = pending(lease);
  if (!marker) return true;
  const deadline = Date.parse(marker.deadlineAt as string);
  if (!Number.isFinite(deadline) || deadline > now.getTime()) return false;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId!),
    eq(heartbeatRuns.runtimeMode, "legacy"),
  ));
  if (!run) return false;
  // The old container may have been killed before its timeout handler. Pin the
  // exact source and repair hold before permitting any provider cleanup.
  const preserved = await terminalizeLegacyExecution({ db, run, status: run.status,
    recordRestoreFailureOnly: true, patch: { resultJson: { workspaceRestoreFailure: "restore_failed" } } });
  if (!preserved) return false;
  await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata},
    '{legacyShutdownWorkspaceSettlement,state}', '"expired"'::jsonb)` }).where(and(
    eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, run.id),
    sql`${environmentLeases.metadata}->'legacyShutdownWorkspaceSettlement' = ${JSON.stringify(marker)}::jsonb`,
  ));
  return true;
}
