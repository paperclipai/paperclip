import { and, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { runtimeServices, runtimeServiceCompanyPolicies, runtimeServiceAllocations, runtimeServiceDataDeletions, type Db } from "@paperclipai/db";

/** Stopped retained files alone need no continuously running controller. */
export async function runtimeServiceControllerRequirements(db: Db) {
  const [services, deletions, allocations, expiringData] = await Promise.all([
    db.select({ id: runtimeServices.id }).from(runtimeServices).where(or(
      eq(runtimeServices.desiredState, "running"),
      notInArray(runtimeServices.state, ["stopped", "sleeping", "deleted", "failed"]),
      sql`${runtimeServices.processRef} IS NOT NULL AND coalesce(${runtimeServices.processRef}->>'retired', 'false') <> 'true'`,
      sql`${runtimeServices.processHandoff}->>'phase' = 'pending'`,
      and(isNotNull(runtimeServices.controllerId), gt(runtimeServices.controllerExpiresAt, new Date())),
    )).limit(1),
    db.select({ id: runtimeServiceDataDeletions.id }).from(runtimeServiceDataDeletions).where(or(
      inArray(runtimeServiceDataDeletions.state, ["pending", "deleting"]),
      and(eq(runtimeServiceDataDeletions.state, "failed"), isNotNull(runtimeServiceDataDeletions.retryAt)),
    )).limit(1),
    db.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations).where(or(
      sql`${runtimeServiceAllocations.metadata}->>'acquisitionStarted' = 'true' AND ${runtimeServiceAllocations.metadata}->>'provisionedAt' IS NULL`,
      sql`${runtimeServiceAllocations.metadata}->>'retentionError' = 'true'`,
    )).limit(1),
    db.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
      .innerJoin(runtimeServiceCompanyPolicies, eq(runtimeServiceCompanyPolicies.companyId, runtimeServiceAllocations.companyId))
      .where(and(isNull(runtimeServiceAllocations.dataDeletionId),
        sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`,
        sql`${runtimeServiceCompanyPolicies.config}->>'retainedDataSeconds' IS NOT NULL`,
        sql`exists (select 1 from ${runtimeServices} where ${runtimeServices.allocationId} = ${runtimeServiceAllocations.id} and ${runtimeServices.companyId} = ${runtimeServiceAllocations.companyId})`,
      )).limit(1),
  ]);
  return { runtimeServiceControllerRequired: services.length + deletions.length + allocations.length + expiringData.length > 0 };
}
