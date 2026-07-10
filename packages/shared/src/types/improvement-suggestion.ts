export const IMPROVEMENT_SUGGESTION_ORIGIN_KINDS = [
  "board_directed",
  "agent_detected",
  "feedback_detected",
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

export const IMPROVEMENT_SCOPES = ["company", "instance"] as const;
export type ImprovementScope = (typeof IMPROVEMENT_SCOPES)[number];

export const ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS = [
  "root_skill",
  "orchestration_code",
  "qa_gate",
  "workspace_guard",
] as const satisfies readonly ImprovementTargetLayer[];

export function isRootLevelImprovementTarget(
  targetLayer: ImprovementTargetLayer,
): targetLayer is (typeof ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS)[number] {
  return (ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS as readonly string[]).includes(targetLayer);
}

export function improvementScopeForTarget(targetLayer: ImprovementTargetLayer): ImprovementScope {
  return isRootLevelImprovementTarget(targetLayer) ? "instance" : "company";
}

export const IMPROVEMENT_EVIDENCE_KINDS = [
  "issue",
  "comment",
  "run",
  "log",
  "document",
  "file",
  "url",
  "feedback_vote",
  "other",
] as const;
export type ImprovementEvidenceKind = (typeof IMPROVEMENT_EVIDENCE_KINDS)[number];

export interface ImprovementSuggestionEvidence {
  kind: ImprovementEvidenceKind;
  ref: string;
  note: string | null;
}

export interface ImprovementImplementationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
}

export interface ImprovementSuggestion {
  id: string;
  companyId: string;
  originKind: ImprovementSuggestionOriginKind;
  status: ImprovementSuggestionStatus;
  scope: ImprovementScope;
  targetLayer: ImprovementTargetLayer;
  title: string;
  summary: string;
  proposedChange: string;
  evidence: ImprovementSuggestionEvidence[];
  sourceIssueId: string | null;
  sourceRunId: string | null;
  sourceFeedbackVoteId: string | null;
  implementationIssueId: string | null;
  implementationIssue: ImprovementImplementationIssueSummary | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstanceImprovementSuggestion extends ImprovementSuggestion {
  companyName: string;
  companyIssuePrefix: string;
}
