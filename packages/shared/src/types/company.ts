import type {
  CompanyInfraMode,
  CompanyStatus,
  InfraCapability,
  InfraEntitlementMode,
  InfraEntitlementStatus,
  PauseReason,
} from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  websiteUrl: string | null;
  founderUrl: string | null;
  infraMode: CompanyInfraMode;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
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

export interface CompanyInfraEntitlement {
  id: string;
  companyId: string;
  capability: InfraCapability;
  mode: InfraEntitlementMode;
  status: InfraEntitlementStatus;
  provider: string | null;
  bindingRef: string | null;
  provisionedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
