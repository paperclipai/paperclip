import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  recoveryEngineerConfigs,
  recoveryEngineerIncidents,
  recoveryEngineerIncidentSources,
} from "@paperclipai/db";
import type {
  RecoveryEngineerClassification,
  RecoveryEngineerProcedureApplicability,
  RecoveryEngineerProcedureApplicabilityReason,
  RecoveryEngineerProcedureApplicabilityVerdict,
  RecoveryEngineerProcedureReuseStatus,
} from "@paperclipai/shared";

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

/**
 * Incident statuses that still own the next action on their linked issues.
 * `resumed` is included on purpose: a dispatched resume whose source
 * generations have not produced recovery evidence is still the recovery
 * engineer's loop to close (replay, evidence, or a board wait), so the generic
 * recovery engine must not fight it for the same issue.
 */
export const RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES = [
  ...ACTIVE_INCIDENT_STATUSES,
  "resumed",
] as const;

/** A procedure that failed this many recorded applications needs new evidence
 * and a new review instead of another retry. */
export const RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES = 2;

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
      inArray(recoveryEngineerIncidents.status, RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES),
      or(
        eq(recoveryEngineerIncidents.maintenanceIssueId, issueId),
        eq(recoveryEngineerIncidents.repairIssueId, issueId),
        and(
          eq(recoveryEngineerIncidentSources.sourceIssueId, issueId),
          isNull(recoveryEngineerIncidentSources.recoveredAt),
          // A generation the incident explicitly superseded is no longer an
          // active ownership claim; its native owner owns the issue's next
          // action again.
          isNull(recoveryEngineerIncidentSources.supersededAt),
        ),
      ),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

/**
 * Gates that make a live procedure application unsafe. A procedure never
 * overrides a gate: whoever holds the gate owns the next move.
 */
export type RecoveryEngineerProcedureApplicabilityGate =
  | "none"
  | "human"
  | "provider"
  | "dependency"
  | "owner";

export type RecoveryEngineerProcedureApplicabilityProcedure = {
  status: string;
  failureFingerprint: string;
  classification: RecoveryEngineerClassification | null;
  repairCommit: string;
  applicability: RecoveryEngineerProcedureApplicability | null;
  failedReuseCount: number;
  invalidatedAt: Date | null;
};

export type RecoveryEngineerProcedureApplicabilityContext = {
  failureFingerprint: string | null;
  classification: RecoveryEngineerClassification | null;
  /** Adapter of the run that is currently executing the source issue, when
   * known. A procedure reviewed against one adapter is not portable. */
  adapterType: string | null;
  gate: RecoveryEngineerProcedureApplicabilityGate;
  /** The repair commit activated for the incident this procedure would be
   * applied to. An old review never authorizes a different deployed fix. */
  activatedRepairCommit: string | null;
  sourceGenerationKey: string | null;
};

export type RecoveryEngineerProcedureReuseSummary = {
  status: RecoveryEngineerProcedureReuseStatus;
  evidenceKey: string;
  sourceGenerationKey: string;
};

function refuse(
  reason: RecoveryEngineerProcedureApplicabilityReason,
  requiresNewEvidence = false,
): RecoveryEngineerProcedureApplicabilityVerdict {
  return { applicable: false, reason, requiresNewEvidence };
}

/**
 * Pure applicability rule for reusing a reviewed procedure. This is a
 * diagnostic aid, never an executable grant: it decides only whether the
 * recorded procedure still describes the context it was reviewed in and
 * whether the evidence being offered is genuinely new.
 */
export function evaluateRecoveryEngineerProcedureApplicability(input: {
  procedure: RecoveryEngineerProcedureApplicabilityProcedure;
  context: RecoveryEngineerProcedureApplicabilityContext;
  evidenceKey: string | null | undefined;
  reuseHistory: readonly RecoveryEngineerProcedureReuseSummary[];
}): RecoveryEngineerProcedureApplicabilityVerdict {
  const procedure = input.procedure;
  if (procedure.invalidatedAt) return refuse("procedure_invalidated");
  if (procedure.status === "retired") return refuse("procedure_retired");
  if (procedure.status !== "reviewed") return refuse("procedure_not_reviewed");
  if (input.context.failureFingerprint !== procedure.failureFingerprint) {
    return refuse("failure_fingerprint_mismatch");
  }
  if (procedure.classification && input.context.classification !== procedure.classification) {
    return refuse("classification_mismatch");
  }
  const reviewedAdapterType = procedure.applicability?.adapterType ?? null;
  if (reviewedAdapterType && input.context.adapterType !== reviewedAdapterType) {
    return refuse("adapter_capability_mismatch");
  }
  if (!input.context.activatedRepairCommit) return refuse("repair_not_activated");
  if (input.context.activatedRepairCommit !== procedure.repairCommit) {
    return refuse("repair_commit_mismatch");
  }
  if (input.context.gate !== "none") return refuse("gate_owned_by_another_actor");
  const evidenceKey = input.evidenceKey?.trim() ?? null;
  const unsuccessful = input.reuseHistory.filter(
    (reuse) => reuse.status === "failed" || reuse.status === "refused",
  );
  if (evidenceKey && unsuccessful.some((reuse) => reuse.evidenceKey === evidenceKey)) {
    return refuse("repeat_after_failed_reuse", true);
  }
  if (procedure.failedReuseCount >= RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES) {
    return refuse("procedure_requires_new_review", true);
  }
  if (
    input.context.sourceGenerationKey &&
    input.reuseHistory.some(
      (reuse) => reuse.status === "succeeded" &&
        reuse.sourceGenerationKey === input.context.sourceGenerationKey,
    )
  ) {
    return refuse("generation_already_succeeded");
  }
  return { applicable: true, reason: null, requiresNewEvidence: false };
}
