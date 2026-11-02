import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentCustomImageSetupSessions, environmentLeases, type Db } from "@paperclipai/db";
import { beginIdleTrackedWork } from "./task-admission.js";
import { finishedIdleRun } from "./idle-work-proof.js";
import { CLEANUP_ROW_STAMP_FORMAT, CLEANUP_VERIFICATION_KEY, CLEANUP_VERIFICATION_SCHEMA, cleanupRowStamp, verifiedResourceCleanup } from "./cleanup-verification-proof.js";

type Lease = typeof environmentLeases.$inferSelect;
type Setup = typeof environmentCustomImageSetupSessions.$inferSelect;
type Inspectors = {
  inspectLease(lease: Lease): Promise<unknown>;
  inspectSetup(setup: Setup): Promise<unknown>;
};
type Result = { checked: number; verified: number; deferred: number; failed: number };

/** Read provider state only. Preserve failures and retained data; observing an
 * allocation never starts or destroys it. Older workers simply defer proof. */
export function historicalCleanupVerificationService(db: Db, inspectors: Inspectors) {
  let inFlight: Promise<Result> | undefined;
  let leaseCursor = "";
  let setupCursor = "";
  async function run(): Promise<Result> {
    const finish = beginIdleTrackedWork();
    const result: Result = { checked: 0, verified: 0, deferred: 0, failed: 0 };
    try {
      const leases = await db.select({ row: environmentLeases, stamp: sql<string>`${sql.raw(cleanupRowStamp('environment_leases'))}` })
        .from(environmentLeases).where(and(
          eq(environmentLeases.status, "failed"), eq(environmentLeases.leasePolicy, "ephemeral"),
          eq(environmentLeases.cleanupStatus, "success"),
          sql`${environmentLeases.id}::text > ${leaseCursor}`,
          sql`${environmentLeases.releasedAt} IS NOT NULL AND ${environmentLeases.environmentId} IS NOT NULL`,
          sql`${environmentLeases.provider} IS NOT NULL AND ${environmentLeases.provider} <> 'local'
            AND ${environmentLeases.providerLeaseId} IS NOT NULL`,
          sql`COALESCE(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') = 'false'
            AND NOT (COALESCE(${environmentLeases.metadata}, '{}'::jsonb) ?| ARRAY['nativeWorkspaceExportResume', 'sandboxStopAndRetain'])`,
          sql`(${sql.raw(verifiedResourceCleanup('environment_leases', 'lease'))}) IS NOT TRUE`,
          sql`(${environmentLeases.heartbeatRunId} IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs historical_run
            WHERE historical_run.id = ${environmentLeases.heartbeatRunId} AND historical_run.company_id = ${environmentLeases.companyId}
              AND ${sql.raw(finishedIdleRun('historical_run'))}))`,
          sql`NOT EXISTS (SELECT 1 FROM environment_leases other_owner
            WHERE other_owner.id <> ${environmentLeases.id} AND other_owner.provider = ${environmentLeases.provider}
              AND other_owner.provider_lease_id = ${environmentLeases.providerLeaseId}
              AND other_owner.status IN ('active', 'retained', 'pending_cleanup'))`,
          sql`NOT EXISTS (SELECT 1 FROM environment_custom_image_setup_sessions setup_owner
            WHERE setup_owner.provider = ${environmentLeases.provider} AND setup_owner.provider_lease_id = ${environmentLeases.providerLeaseId}
              AND (setup_owner.finished_at IS NULL OR setup_owner.connection_secret_ref IS NOT NULL))`,
        )).orderBy(environmentLeases.id).limit(16);
      const setups = await db.select({ row: environmentCustomImageSetupSessions,
        stamp: sql<string>`${sql.raw(cleanupRowStamp('environment_custom_image_setup_sessions'))}` })
        .from(environmentCustomImageSetupSessions).where(and(
          inArray(environmentCustomImageSetupSessions.status, ["promoted", "cancelled", "timed_out", "failed"]),
          sql`${environmentCustomImageSetupSessions.id}::text > ${setupCursor}`,
          sql`${environmentCustomImageSetupSessions.finishedAt} IS NOT NULL
            AND ${environmentCustomImageSetupSessions.connectionSecretRef} IS NULL
            AND ${environmentCustomImageSetupSessions.providerLeaseId} IS NOT NULL`,
          sql`(${sql.raw(verifiedResourceCleanup('environment_custom_image_setup_sessions', 'image_setup'))}) IS NOT TRUE`,
          sql`NOT EXISTS (SELECT 1 FROM environment_leases lease_owner
            WHERE lease_owner.provider = ${environmentCustomImageSetupSessions.provider}
              AND lease_owner.provider_lease_id = ${environmentCustomImageSetupSessions.providerLeaseId}
              AND lease_owner.status NOT IN ('released', 'expired', 'failed'))`,
        )).orderBy(environmentCustomImageSetupSessions.id).limit(16);
      leaseCursor = leases.length === 16 ? leases.at(-1)!.row.id : "";
      setupCursor = setups.length === 16 ? setups.at(-1)!.row.id : "";
      // Keep provider concurrency bounded. Each operation is an observation;
      // every accepted receipt must also win the row-version comparison below.
      const jobs = [
        ...leases.map(snapshot => async () => inspect("lease", snapshot.row, snapshot.stamp)),
        ...setups.map(snapshot => async () => inspect("image_setup", snapshot.row, snapshot.stamp)),
      ];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
        for (;;) { const index = next++; if (index >= jobs.length) return; await jobs[index]!(); }
      }));
      return result;
    } finally { finish(); }

    async function inspect(kind: "lease" | "image_setup", row: Lease | Setup, stamp: string) {
      result.checked += 1;
      try {
        const observation = await (kind === "lease" ? inspectors.inspectLease(row as Lease) : inspectors.inspectSetup(row as Setup)) as {
          providerLeaseId?: unknown; state?: unknown;
        } | null | undefined;
        if (observation?.state !== "destroyed" || !row.providerLeaseId || observation.providerLeaseId !== row.providerLeaseId) {
          result.deferred += 1; return;
        }
        const now = new Date();
        const companyId = kind === "lease" ? (row as Lease).companyId
          : typeof row.metadata?.setupRpcCompanyId === "string" && row.metadata.setupRpcCompanyId.trim()
            ? row.metadata.setupRpcCompanyId.trim() : "instance";
        const proof = { schema: CLEANUP_VERIFICATION_SCHEMA, kind, resourceId: row.id, companyId,
          environmentId: row.environmentId, provider: row.provider, providerLeaseId: row.providerLeaseId,
          heartbeatRunId: kind === "lease" ? (row as Lease).heartbeatRunId : null,
          state: "destroyed", confirmedAt: now.toISOString() };
        const metadata = sql`COALESCE(${kind === "lease" ? environmentLeases.metadata : environmentCustomImageSetupSessions.metadata}, '{}'::jsonb)
          || jsonb_build_object(${CLEANUP_VERIFICATION_KEY}::text, ${JSON.stringify(proof)}::jsonb
            || jsonb_build_object('rowUpdatedAt', to_char(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${CLEANUP_ROW_STAMP_FORMAT})))`;
        let updated: Array<{ id: string }>;
        if (kind === "lease") {
          const lease = row as Lease;
          updated = await db.update(environmentLeases).set({ metadata, updatedAt: now }).where(and(
            eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
            eq(environmentLeases.status, "failed"), eq(environmentLeases.leasePolicy, "ephemeral"),
            eq(environmentLeases.cleanupStatus, "success"),
            sql`${environmentLeases.provider} IS NOT DISTINCT FROM ${lease.provider}
              AND ${environmentLeases.providerLeaseId} IS NOT DISTINCT FROM ${lease.providerLeaseId}
              AND ${environmentLeases.environmentId} IS NOT DISTINCT FROM ${lease.environmentId}::uuid
              AND ${environmentLeases.heartbeatRunId} IS NOT DISTINCT FROM ${lease.heartbeatRunId}::uuid
              AND ${environmentLeases.releasedAt} IS NOT NULL`,
            sql`(${environmentLeases.heartbeatRunId} IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs verify_run
              WHERE verify_run.id = ${environmentLeases.heartbeatRunId} AND verify_run.company_id = ${environmentLeases.companyId}
                AND ${sql.raw(finishedIdleRun('verify_run'))}))`,
            sql`${sql.raw(cleanupRowStamp('environment_leases'))} = ${stamp}
              AND ${environmentLeases.metadata} IS NOT DISTINCT FROM ${(lease.metadata === null ? null : JSON.stringify(lease.metadata))}::jsonb`,
            sql`NOT EXISTS (SELECT 1 FROM environment_leases other_owner
              WHERE other_owner.id <> ${environmentLeases.id} AND other_owner.provider = ${environmentLeases.provider}
                AND other_owner.provider_lease_id = ${environmentLeases.providerLeaseId}
                AND other_owner.status IN ('active', 'retained', 'pending_cleanup'))`,
            sql`NOT EXISTS (SELECT 1 FROM environment_custom_image_setup_sessions setup_owner
              WHERE setup_owner.provider = ${environmentLeases.provider} AND setup_owner.provider_lease_id = ${environmentLeases.providerLeaseId}
                AND (setup_owner.finished_at IS NULL OR setup_owner.connection_secret_ref IS NOT NULL))`,
          )).returning({ id: environmentLeases.id });
        } else {
          const setup = row as Setup;
          updated = await db.update(environmentCustomImageSetupSessions).set({ metadata, updatedAt: now }).where(and(
            eq(environmentCustomImageSetupSessions.id, setup.id), eq(environmentCustomImageSetupSessions.status, setup.status),
            sql`${environmentCustomImageSetupSessions.provider} IS NOT DISTINCT FROM ${setup.provider}
              AND ${environmentCustomImageSetupSessions.providerLeaseId} IS NOT DISTINCT FROM ${setup.providerLeaseId}
              AND ${environmentCustomImageSetupSessions.environmentId} = ${setup.environmentId}::uuid
              AND ${environmentCustomImageSetupSessions.finishedAt} IS NOT NULL`,
            sql`NOT EXISTS (SELECT 1 FROM environment_leases lease_owner
              WHERE lease_owner.provider = ${environmentCustomImageSetupSessions.provider}
                AND lease_owner.provider_lease_id = ${environmentCustomImageSetupSessions.providerLeaseId}
                AND lease_owner.status NOT IN ('released', 'expired', 'failed'))`,
            sql`${sql.raw(cleanupRowStamp('environment_custom_image_setup_sessions'))} = ${stamp}
              AND ${environmentCustomImageSetupSessions.metadata} IS NOT DISTINCT FROM ${(setup.metadata === null ? null : JSON.stringify(setup.metadata))}::jsonb
              AND ${environmentCustomImageSetupSessions.connectionSecretRef} IS NULL`,
          )).returning({ id: environmentCustomImageSetupSessions.id });
        }
        if (updated.length === 1) result.verified += 1;
        else result.deferred += 1;
      } catch {
        // Provider exceptions may contain credentials. Keep only a count.
        result.failed += 1;
      }
    }
  }
  async function hasPending(): Promise<boolean> {
    const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.status, "failed"), eq(environmentLeases.leasePolicy, "ephemeral"),
      eq(environmentLeases.cleanupStatus, "success"),
      sql`${environmentLeases.releasedAt} IS NOT NULL AND ${environmentLeases.environmentId} IS NOT NULL
        AND ${environmentLeases.provider} IS NOT NULL AND ${environmentLeases.provider} <> 'local'
        AND ${environmentLeases.providerLeaseId} IS NOT NULL`,
      sql`(${sql.raw(verifiedResourceCleanup('environment_leases', 'lease'))}) IS NOT TRUE`,
    )).limit(1);
    if (lease) return true;
    const [setup] = await db.select({ id: environmentCustomImageSetupSessions.id }).from(environmentCustomImageSetupSessions).where(and(
      inArray(environmentCustomImageSetupSessions.status, ["promoted", "cancelled", "timed_out", "failed"]),
      sql`${environmentCustomImageSetupSessions.finishedAt} IS NOT NULL AND ${environmentCustomImageSetupSessions.providerLeaseId} IS NOT NULL`,
      sql`(${sql.raw(verifiedResourceCleanup('environment_custom_image_setup_sessions', 'image_setup'))}) IS NOT TRUE`,
    )).limit(1);
    return Boolean(setup);
  }
  return { hasPending, sweep(): Promise<Result> {
    if (!inFlight) inFlight = run().finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}
