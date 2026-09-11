export const RECOVERY_ENGINEER_CLASSIFICATIONS = [
  "infrastructure",
  "task_defect",
  "human_gate",
  "provider_gate",
  "already_recovered",
] as const;

export type RecoveryEngineerClassification =
  (typeof RECOVERY_ENGINEER_CLASSIFICATIONS)[number];

export const RECOVERY_ENGINEER_PROCEDURE_STATUSES = [
  "proposed",
  "reviewed",
  "retired",
] as const;

export type RecoveryEngineerProcedureStatus =
  (typeof RECOVERY_ENGINEER_PROCEDURE_STATUSES)[number];

/**
 * The repair outcome of an incident. `recovered` is only ever recorded after
 * positive evidence that the original failing operation was overcome on the
 * source's own execution path; queueing a continuation is not recovery.
 */
export const RECOVERY_ENGINEER_INCIDENT_OUTCOMES = [
  "pending",
  "recovered",
  "unresolved",
] as const;

export type RecoveryEngineerIncidentOutcome =
  (typeof RECOVERY_ENGINEER_INCIDENT_OUTCOMES)[number];

/**
 * Every way a source failure generation can stop being open. The reasons that
 * close a generation as recovered carry original-path or native-closure
 * evidence; the remaining reasons record that this generation can no longer be
 * recovered by the incident (superseded, cancelled, stale, or exhausted).
 */
export const RECOVERY_ENGINEER_SOURCE_CLOSE_REASONS = [
  "original_path_run",
  "source_issue_completed",
  "diagnosis_already_recovered",
  "source_cancelled",
  "source_issue_missing",
  "source_owner_changed",
  "source_owner_human",
  "source_generation_advanced",
  "source_gate_changed",
  "continuation_failed",
  "continuation_without_progress",
  "superseded_by_newer_generation",
  "resume_attempts_exhausted",
  "incident_closed_natively",
] as const;

export type RecoveryEngineerSourceCloseReason =
  (typeof RECOVERY_ENGINEER_SOURCE_CLOSE_REASONS)[number];

export const RECOVERY_ENGINEER_PROCEDURE_REUSE_STATUSES = [
  "applied",
  "succeeded",
  "failed",
  "refused",
] as const;

export type RecoveryEngineerProcedureReuseStatus =
  (typeof RECOVERY_ENGINEER_PROCEDURE_REUSE_STATUSES)[number];

/**
 * The context a reviewed procedure is bound to. Recorded when the procedure is
 * proposed from a real evidence run, and re-matched before the procedure can be
 * reused, so an old review never authorizes a new context.
 */
export interface RecoveryEngineerProcedureApplicability {
  adapterType: string | null;
  failureFingerprint: string;
  classification: RecoveryEngineerClassification | null;
  evidenceRunId: string;
  sourceGenerationKey: string | null;
  sourceStatusVersion: number | null;
}

export interface RecoveryEngineerProcedureReuse {
  id: string;
  companyId: string;
  incidentId: string;
  procedureId: string;
  sourceIssueId: string;
  sourceGenerationKey: string;
  failureFingerprint: string;
  evidenceKey: string;
  status: RecoveryEngineerProcedureReuseStatus;
  refusalReason: string | null;
  applicability: Record<string, unknown>;
  evidence: Record<string, unknown>;
  appliedByAgentId: string | null;
  appliedByRunId: string | null;
  appliedByUserId: string | null;
  appliedAt: Date;
  outcomeAt: Date | null;
  outcomeRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RecoveryEngineerProcedureApplicabilityReason =
  | "procedure_not_reviewed"
  | "procedure_retired"
  | "procedure_invalidated"
  | "failure_fingerprint_mismatch"
  | "classification_mismatch"
  | "adapter_capability_mismatch"
  | "repair_not_activated"
  | "repair_commit_mismatch"
  | "gate_owned_by_another_actor"
  | "generation_already_succeeded"
  | "repeat_after_failed_reuse"
  | "procedure_requires_new_review";

export interface RecoveryEngineerProcedureApplicabilityVerdict {
  applicable: boolean;
  reason: RecoveryEngineerProcedureApplicabilityReason | null;
  /** True when the refusal is only because this evidence was already tried:
   * new evidence can legitimately be applied again. */
  requiresNewEvidence: boolean;
}

export interface RecoveryEngineerReviewedProcedure extends RecoveryEngineerProcedure {
  applicabilityVerdict: RecoveryEngineerProcedureApplicabilityVerdict;
  reuses: RecoveryEngineerProcedureReuse[];
}

export interface RecoveryEngineerRepairProjectIds {
  framework?: string;
  native?: string;
}

export interface RecoveryEngineerConfig {
  enabled: boolean;
  agentId: string;
  repairAgentId: string;
  reviewerAgentId: string;
  projectId: string;
  repairProjectIds?: RecoveryEngineerRepairProjectIds;
  maxAttempts: 1;
  sweepIntervalSec: 300;
}

export interface RecoveryEngineerIncidentSource {
  id: string;
  sourceIssueId: string;
  sourceRunId: string | null;
  generationKey: string;
  originalOwnerAgentId: string | null;
  originalOwnerUserId: string | null;
  sourceStatus: string;
  sourceStatusVersion: number;
  sourceUpdatedAt: Date;
  checkoutRunId: string | null;
  executionRunId: string | null;
  evidence: Record<string, unknown>;
  observedAt: Date;
  recoveredAt: Date | null;
  recoveredRunId: string | null;
  recoveredEvidence: Record<string, unknown> | null;
  resumeClaimedAt: Date | null;
  resumeIdempotencyKey: string | null;
  resumeAttemptCount: number;
  resumeLastAttemptAt: Date | null;
  resumeDispatchedAt: Date | null;
  resumeFailureReason: string | null;
  resumedAt: Date | null;
  resumedRunId: string | null;
  supersededAt: Date | null;
  supersededReason: RecoveryEngineerSourceCloseReason | null;
  supersededBySourceId: string | null;
}

export interface RecoveryEngineerIncident {
  id: string;
  companyId: string;
  failureFingerprint: string;
  status: string;
  outcome: RecoveryEngineerIncidentOutcome;
  outcomeUpdatedAt: Date | null;
  classification: RecoveryEngineerClassification | null;
  hypothesis: string | null;
  rootCause: string | null;
  evidence: string[];
  maintenanceIssueId: string | null;
  diagnosisAttemptCount: number;
  diagnosisRunId: string | null;
  boardEscalatedAt: Date | null;
  repairTarget: "framework" | "native" | null;
  repairIssueId: string | null;
  repairRunId: string | null;
  repairCommit: string | null;
  verifiedReviewRunId: string | null;
  verifiedAt: Date | null;
  activatedRepairCommit: string | null;
  activationEvidence: string | null;
  activatedByUserId: string | null;
  activatedAt: Date | null;
  resumedSourceIssueId: string | null;
  resumedRunId: string | null;
  resumedAt: Date | null;
  suspectedAt: Date;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecoveryEngineerProcedure {
  id: string;
  companyId: string;
  incidentId: string;
  status: RecoveryEngineerProcedureStatus;
  title: string;
  preconditions: string[];
  steps: string[];
  successCheck: string;
  stopConditions: string[];
  rollback: string;
  evidenceRunId: string;
  repairCommit: string;
  failureFingerprint: string;
  classification: RecoveryEngineerClassification | null;
  applicability: RecoveryEngineerProcedureApplicability | null;
  failedReuseCount: number;
  lastReuseOutcome: RecoveryEngineerProcedureReuseStatus | null;
  lastReusedAt: Date | null;
  invalidatedAt: Date | null;
  invalidatedReason: string | null;
  proposedByAgentId: string | null;
  proposedByRunId: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecoveryEngineerVerification {
  id: string;
  incidentId: string;
  repairIssueId: string;
  reviewRunId: string;
  status: "pending" | "verified" | "failed";
  repairCommit: string;
  reproductionCommand: string;
  reproductionResult: string;
  failureReason: string | null;
  duplicateOfVerificationId: string | null;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  submittedAt: Date;
  finalizedAt: Date | null;
}

export interface RecoveryEngineerPagination {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RecoveryEngineerReadResponse {
  config: RecoveryEngineerConfig;
  incident: RecoveryEngineerIncident;
  sources: RecoveryEngineerIncidentSource[];
  sourcesPage: RecoveryEngineerPagination;
  reviewedProcedures: RecoveryEngineerReviewedProcedure[];
  proceduresPage: RecoveryEngineerPagination;
  resumeGate: {
    status: "verification_required" | "activation_required" | "activation_confirmed";
    verifiedRepairCommit: string | null;
    activatedRepairCommit: string | null;
    activatedAt: Date | null;
    activationEvidence: string | null;
  };
  verification: RecoveryEngineerVerification | null;
}

export interface RecoveryEngineerDiagnoseInput {
  action: "diagnose";
  classification: RecoveryEngineerClassification;
  hypothesis: string;
  rootCause?: string;
  evidence: string[];
  repairIssueId?: string;
}

export interface RecoveryEngineerProcedureInput {
  action: "propose_procedure";
  title: string;
  preconditions: string[];
  steps: string[];
  successCheck: string;
  stopConditions: string[];
  rollback: string;
  evidenceRunId: string;
  repairCommit: string;
}

export interface RecoveryEngineerRepairInput {
  action: "request_repair";
  target: "framework" | "native";
  title: string;
  description: string;
}

export interface RecoveryEngineerVerifyInput {
  action: "verify";
  reviewRunId: string;
  repairCommit: string;
  reproductionCommand: string;
  reproductionResult: string;
}

export interface RecoveryEngineerResumeInput {
  action: "resume";
  sourceIssueId: string;
}

export interface RecoveryEngineerProcedureReuseInput {
  action: "reuse_procedure";
  procedureId: string;
  outcome?: "applied" | "succeeded" | "failed";
  evidenceKey: string;
  sourceIssueId?: string;
  failureReason?: string;
  evidence?: Record<string, unknown>;
}

export type RecoveryEngineerRecordInput =
  | RecoveryEngineerDiagnoseInput
  | RecoveryEngineerProcedureInput
  | RecoveryEngineerRepairInput
  | RecoveryEngineerVerifyInput
  | RecoveryEngineerResumeInput
  | RecoveryEngineerProcedureReuseInput;

export interface RecoveryEngineerProcedureReviewInput {
  status: "reviewed" | "retired";
  reviewNote: string;
}
