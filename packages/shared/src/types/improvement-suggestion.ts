export const IMPROVEMENT_SUGGESTION_ORIGIN_KINDS = [
  "board_directed",
  "agent_detected",
] as const;
export type ImprovementSuggestionOriginKind = (typeof IMPROVEMENT_SUGGESTION_ORIGIN_KINDS)[number];

export const IMPROVEMENT_SUGGESTION_STATUSES = [
  "pending_review",
  "accepted",
  "rejected",
] as const;
export type ImprovementSuggestionStatus = (typeof IMPROVEMENT_SUGGESTION_STATUSES)[number];

export const IMPROVEMENT_TARGET_LAYERS = [
  "agent_prompt",
  "company_skill",
  "root_skill",
  "orchestration_code",
  "qa_gate",
  "workspace_guard",
  "company_sop",
] as const;
export type ImprovementTargetLayer = (typeof IMPROVEMENT_TARGET_LAYERS)[number];

export const IMPROVEMENT_EVIDENCE_KINDS = [
  "issue",
  "comment",
  "run",
  "log",
  "document",
  "file",
  "url",
  "other",
] as const;
export type ImprovementEvidenceKind = (typeof IMPROVEMENT_EVIDENCE_KINDS)[number];

export interface ImprovementSuggestionEvidence {
  kind: ImprovementEvidenceKind;
  ref: string;
  note: string | null;
}

export interface ImprovementSuggestion {
  id: string;
  companyId: string;
  originKind: ImprovementSuggestionOriginKind;
  status: ImprovementSuggestionStatus;
  targetLayer: ImprovementTargetLayer;
  title: string;
  summary: string;
  proposedChange: string;
  evidence: ImprovementSuggestionEvidence[];
  sourceIssueId: string | null;
  sourceRunId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
