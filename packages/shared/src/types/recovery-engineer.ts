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
  resumeClaimedAt: Date | null;
  resumedAt: Date | null;
  resumedRunId: string | null;
}

export interface RecoveryEngineerIncident {
  id: string;
  companyId: string;
  failureFingerprint: string;
  status: string;
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
  reviewedProcedures: RecoveryEngineerProcedure[];
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

export type RecoveryEngineerRecordInput =
  | RecoveryEngineerDiagnoseInput
  | RecoveryEngineerProcedureInput
  | RecoveryEngineerRepairInput
  | RecoveryEngineerVerifyInput
  | RecoveryEngineerResumeInput;

export interface RecoveryEngineerProcedureReviewInput {
  status: "reviewed" | "retired";
  reviewNote: string;
}
