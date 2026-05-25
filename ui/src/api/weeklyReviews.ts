import { api } from "./client";

export interface WeeklyReviewRecord {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  latestVersionId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReviewVersionRecord {
  id: string;
  reviewId: string;
  companyId: string;
  versionNumber: number;
  status: string;
  generatedAt: string | null;
  generatedByUserId: string | null;
  sourceWindowStart: string;
  sourceWindowEnd: string;
  summaryJson: Record<string, unknown> | null;
  validationJson: Record<string, unknown> | null;
  narrationStatus: string;
  narrationText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReviewFindingRecord {
  id: string;
  reviewId: string;
  versionId: string;
  companyId: string;
  stableId: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  workstream: string | null;
  evidenceIdsJson: string[] | null;
  recommendedActionJson: Record<string, unknown> | null;
  recommendationText: string | null;
  reasonCode: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  confidence: string | null;
  detectedAt: string | null;
  validationStatus: string;
  rulesTriggeredJson: string[] | null;
  actorId: string | null;
  uiCtaJson: Record<string, unknown> | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReviewCitationRecord {
  id: string;
  reviewId: string;
  versionId: string;
  findingId: string | null;
  companyId: string;
  citationType: string;
  entityType: string;
  entityId: string;
  field: string | null;
  label: string;
  excerpt: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
}

export interface WeeklyReviewRecommendationRecord {
  id: string;
  reviewId: string;
  versionId: string;
  findingId: string | null;
  companyId: string;
  kind: string;
  severity: string;
  state: string;
  title: string;
  rationale: string | null;
  proposedActionJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReviewActionRecord {
  id: string;
  reviewId: string;
  versionId: string;
  findingId: string | null;
  recommendationId: string | null;
  companyId: string;
  actionKind: string;
  status: string;
  requestedByUserId: string | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
  requestJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  activityLogId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReviewDetail {
  review: WeeklyReviewRecord;
  latestVersion: WeeklyReviewVersionRecord | null;
  findings: WeeklyReviewFindingRecord[];
  citations: WeeklyReviewCitationRecord[];
  recommendations: WeeklyReviewRecommendationRecord[];
  actions: WeeklyReviewActionRecord[];
}

export interface WeeklyReviewReadiness {
  reviewId: string;
  versionId: string | null;
  adapterReadiness: Record<string, unknown> | null;
  modelAssurance: Record<string, unknown> | null;
  citationValidation: Record<string, unknown> | null;
}

export interface GenerateWeeklyReviewInput {
  periodStart: string;
  periodEnd: string;
  previousVersionId?: string;
}

export interface CreateWeeklyReviewRecommendationActionInput {
  actionKind: string;
  note?: string;
  title?: string;
  description?: string | null;
  priority?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  request?: Record<string, unknown>;
}

export const weeklyReviewsApi = {
  list: (companyId: string) =>
    api.get<WeeklyReviewRecord[]>(`/companies/${companyId}/weekly-reviews`),
  getReview: (reviewId: string) =>
    api.get<WeeklyReviewDetail>(`/weekly-reviews/${reviewId}`),
  getVersion: (versionId: string) =>
    api.get<{
      version: WeeklyReviewVersionRecord;
      findings: WeeklyReviewFindingRecord[];
      citations: WeeklyReviewCitationRecord[];
      recommendations: WeeklyReviewRecommendationRecord[];
      actions: WeeklyReviewActionRecord[];
    }>(`/weekly-review-versions/${versionId}`),
  getReadiness: (reviewId: string) =>
    api.get<WeeklyReviewReadiness>(`/weekly-reviews/${reviewId}/readiness`),
  generate: (companyId: string, input: GenerateWeeklyReviewInput) =>
    api.post<WeeklyReviewDetail>(`/companies/${companyId}/weekly-reviews/generate`, input),
  refresh: (reviewId: string) =>
    api.post<WeeklyReviewDetail>(`/weekly-reviews/${reviewId}/refresh`, {}),
  createRecommendationAction: (recommendationId: string, input: CreateWeeklyReviewRecommendationActionInput) =>
    api.post<{ action: WeeklyReviewActionRecord; issue?: unknown }>(
      `/weekly-review-recommendations/${recommendationId}/actions`,
      input,
    ),
};
