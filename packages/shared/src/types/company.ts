import type { CompanyStatus, PauseReason } from "../constants.js";

export interface IssueIntakeLintRule {
  /** Display name shown in warning comment */
  name: string;
  /** Regex patterns tested against `title + " " + (description ?? "")`. Rule fires if ANY matches. */
  patterns: string[];
  /** If provided, none of these patterns may match or the rule is skipped. */
  excludePatterns?: string[];
  /** Human-readable routing suggestion shown in the warning comment */
  suggestedAssignee?: string;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  issueIntakeLintRules: IssueIntakeLintRule[] | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
