import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { isBuiltinSandboxProvider } from "./sandbox-provider-runtime.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasNativeWorkspaceExportResume, readNativeWorkspaceExportResume, settleNativeWorkspaceExportResume } from "./native-runtime/native-workspace-export-resume.js";

type Lease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata">;
export const SANDBOX_STOP_AND_RETAIN_KEY = "sandboxStopAndRetain";

export function hasStopOnlyCleanup(lease: Pick<Lease, "metadata">): boolean {
  return hasNativeWorkspaceExportResume(lease)
    || Object.prototype.hasOwnProperty.call(lease.metadata ?? {}, SANDBOX_STOP_AND_RETAIN_KEY);
}

export function stopOnlyCleanupKey(lease: Pick<Lease, "metadata">) {
  return hasNativeWorkspaceExportResume(lease) ? "nativeWorkspaceExportResume" : SANDBOX_STOP_AND_RETAIN_KEY;
}

export function readStopOnlyCleanup(lease: Lease) {
  if (hasNativeWorkspaceExportResume(lease)) return readNativeWorkspaceExportResume(lease);
  const value = lease.metadata?.[SANDBOX_STOP_AND_RETAIN_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  if (intent.schema !== "paperclip.sandbox-stop-and-retain.v1"
    || intent.companyId !== lease.companyId || intent.runId !== lease.heartbeatRunId || !lease.heartbeatRunId
    || intent.leaseId !== lease.id || intent.provider !== lease.provider || !lease.provider
    || intent.providerLeaseId !== lease.providerLeaseId || !lease.providerLeaseId
    || typeof intent.requestId !== "string" || !intent.requestId) return null;
  if (intent.builtinProvider !== undefined) {
    if (intent.builtinProvider !== lease.provider || !isBuiltinSandboxProvider(lease.provider)
      || intent.pluginId !== undefined || lease.metadata?.pluginId != null || lease.metadata?.sandboxProviderPlugin) return null;
    return { ...intent, requestId: intent.requestId, pluginId: null, builtinProvider: lease.provider };
  }
  if (typeof intent.pluginId !== "string" || !intent.pluginId || intent.pluginId !== lease.metadata?.pluginId) return null;
  return { ...intent, requestId: intent.requestId, pluginId: intent.pluginId, builtinProvider: null };
}

/** Persist before provider dispatch so an older worker or a restart cannot turn
 * an explicit stop into ordinary destructive release. Invalid pins stay pending. */
export async function prepareSandboxStopAndRetain(db: Db, lease: Lease) {
  const requestId = randomUUID(), now = new Date();
  const intent = { schema: "paperclip.sandbox-stop-and-retain.v1", requestId,
    companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId,
    ...(lease.provider && isBuiltinSandboxProvider(lease.provider) && !lease.metadata?.sandboxProviderPlugin && lease.metadata?.pluginId == null
      ? { builtinProvider: lease.provider } : { pluginId: lease.metadata?.pluginId }) };
  const [updated] = await db.update(environmentLeases).set({
    status: "pending_cleanup", cleanupStatus: "failed", failureReason: "sandbox_stop_pending", releasedAt: now, updatedAt: now,
    metadata: sql`(coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'remoteExecutionTermination' - 'sandboxStopAndRetainReceipt') || ${JSON.stringify({
      [SANDBOX_STOP_AND_RETAIN_KEY]: intent, pendingCleanupAttemptId: requestId,
      pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0, pendingCleanupRetryCapWarned: false,
    })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.status, "active"),
    sql`${environmentLeases.provider} is not distinct from ${lease.provider}`,
    sql`${environmentLeases.providerLeaseId} is not distinct from ${lease.providerLeaseId}`,
    sql`${environmentLeases.metadata} is not distinct from ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`,
  )).returning();
  return updated ?? null;
}

export async function settleStopOnlyCleanup(db: Db, lease: Lease, options: { attemptId: string; receipt?: unknown }) {
  if (hasNativeWorkspaceExportResume(lease)) return settleNativeWorkspaceExportResume(db, lease, options);
  const intent = readStopOnlyCleanup(lease);
  if (!intent) return null;
  const receipt = remoteTerminationReceipt(lease, options.receipt), stopped = receipt?.state === "stopped";
  const now = new Date();
  const removeIntent: SQL = stopped ? sql`- 'sandboxStopAndRetain'` : sql``;
  const [updated] = await db.update(environmentLeases).set({
    status: stopped ? "released" : "pending_cleanup", cleanupStatus: stopped ? "success" : "failed",
    failureReason: stopped ? null : "sandbox_stop_pending",
    releasedAt: now, lastUsedAt: now, updatedAt: now,
    metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination' ${removeIntent}) || ${JSON.stringify({
      ...(stopped ? { remoteExecutionTermination: receipt, sandboxStopAndRetainReceipt: {
        schema: "paperclip.sandbox-stop-and-retain-receipt.v1", requestId: intent.requestId,
        companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
        provider: lease.provider, providerLeaseId: lease.providerLeaseId,
        ...(intent.pluginId ? { pluginId: intent.pluginId, method: "environmentStopLease" }
          : { builtinProvider: lease.provider, method: "builtin.stopLease" }),
        confirmedAt: receipt.confirmedAt,
      } } : {}),
      pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
    })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.provider, lease.provider!),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), eq(environmentLeases.status, "pending_cleanup"),
    sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${options.attemptId}`,
    sql`${environmentLeases.metadata}->'sandboxStopAndRetain' = ${JSON.stringify(lease.metadata?.[SANDBOX_STOP_AND_RETAIN_KEY])}::jsonb`,
    sql`${environmentLeases.metadata}->>'pluginId' is not distinct from ${intent.pluginId}`,
  )).returning();
  return updated ?? null;
}
