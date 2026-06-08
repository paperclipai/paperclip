import type {
  DocumentLinkTargetType,
  DocumentStatus,
  DocumentType,
} from "../constants.js";
import type { SourceTrustMetadata } from "../trust-policy.js";

export interface DocumentBacklink {
  id: string;
  companyId: string;
  documentId: string;
  targetType: DocumentLinkTargetType;
  targetId: string;
  relationship: string;
  issueDocumentId: string | null;
  issueDocumentKey: string | null;
  title: string | null;
  identifier: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentFeedbackCounts {
  openComments: number;
  resolvedComments: number;
  openReviewThreads: number;
  resolvedReviewThreads: number;
  pendingSuggestions: number;
  acceptedSuggestions: number;
  rejectedSuggestions: number;
  staleAnchors: number;
  orphanedAnchors: number;
}

export interface CompanyDocumentSummary {
  id: string;
  companyId: string;
  title: string | null;
  format: "markdown";
  status: DocumentStatus;
  documentType: DocumentType;
  summary: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lockedAt: Date | null;
  lockedByAgentId: string | null;
  lockedByUserId: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  archivedAt: Date | null;
  archivedByAgentId: string | null;
  archivedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  backlinks: DocumentBacklink[];
  feedbackCounts: DocumentFeedbackCounts;
}

export interface CompanyDocument extends CompanyDocumentSummary {
  body: string;
}

export interface DocumentLink extends DocumentBacklink {}
