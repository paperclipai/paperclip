export type NicheOpportunityStatus = "unreviewed" | "approved_for_analysis" | "deferred" | "rejected";
export type NicheOpportunityTier = "S" | "A" | "B";

export interface NicheOpportunity {
  id: string;
  companyId: string;
  headKeyword: string;
  categoryPath: string;
  tier: NicheOpportunityTier;
  compositeScore: number;
  status: NicheOpportunityStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  miaIssueId: string | null;
  metadata: string | null;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NicheOpportunityListResponse {
  items: NicheOpportunity[];
  total: number;
}

export interface NicheOpportunityReviewRequest {
  action: "approve" | "defer" | "reject";
  reviewNote?: string;
}

export interface NicheOpportunityReviewResponse {
  opportunity: NicheOpportunity;
  miaIssueId?: string;
  miaIssueIdentifier?: string;
}
