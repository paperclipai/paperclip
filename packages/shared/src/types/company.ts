import type { CompanyStatus, PauseReason } from "../constants.js";

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
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyResetRequest {
  confirmCompanyName: string;
}

export interface CompanyResetDeletedCounts {
  agents: number;
  projects: number;
  goals: number;
  issues: number;
  routines: number;
  skills: number;
  labels: number;
  budgets: number;
  secrets: number;
}

export interface CompanyResetResult {
  company: Company;
  deletedCounts: CompanyResetDeletedCounts;
}
