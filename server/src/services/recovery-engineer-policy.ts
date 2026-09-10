import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  recoveryEngineerConfigs,
  recoveryEngineerIncidents,
  recoveryEngineerIncidentSources,
} from "@paperclipai/db";

export const RECOVERY_ENGINEER_ORIGIN_KINDS = {
  incident: "recovery_engineer_incident",
  repair: "recovery_engineer_repair",
} as const;

export const ACTIVE_INCIDENT_STATUSES = [
  "suspected",
  "diagnosing",
  "diagnosed",
  "repairing",
  "verifying",
  "verified",
  "gated",
  "escalated",
] as const;

export function isRecoveryEngineerIssueOrigin(originKind: string | null | undefined) {
  return originKind === RECOVERY_ENGINEER_ORIGIN_KINDS.incident ||
    originKind === RECOVERY_ENGINEER_ORIGIN_KINDS.repair;
}

export async function hasActiveRecoveryEngineerIncidentForIssue(
  db: Db,
  companyId: string,
  issueId: string,
) {
  const row = await db
    .select({ id: recoveryEngineerIncidents.id })
    .from(recoveryEngineerIncidents)
    .leftJoin(
      recoveryEngineerIncidentSources,
      eq(recoveryEngineerIncidentSources.incidentId, recoveryEngineerIncidents.id),
    )
    .innerJoin(
      recoveryEngineerConfigs,
      eq(recoveryEngineerConfigs.companyId, recoveryEngineerIncidents.companyId),
    )
    .where(and(
      eq(recoveryEngineerIncidents.companyId, companyId),
      eq(recoveryEngineerConfigs.enabled, true),
      inArray(recoveryEngineerIncidents.status, ACTIVE_INCIDENT_STATUSES),
      or(
        eq(recoveryEngineerIncidents.maintenanceIssueId, issueId),
        eq(recoveryEngineerIncidents.repairIssueId, issueId),
        and(
          eq(recoveryEngineerIncidentSources.sourceIssueId, issueId),
          isNull(recoveryEngineerIncidentSources.recoveredAt),
        ),
      ),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}
