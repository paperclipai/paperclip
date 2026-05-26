import type {
  WEEKLY_REVIEW_ACTION_STATUSES,
  WEEKLY_REVIEW_ACTION_KINDS,
  WEEKLY_REVIEW_EVENT_STATUSES,
  WEEKLY_REVIEW_EVENT_TYPES,
  WEEKLY_REVIEW_FINDING_CATEGORIES,
  WEEKLY_REVIEW_FINDING_SEVERITIES,
  WEEKLY_REVIEW_FINDING_STATUSES,
  WEEKLY_REVIEW_RECOMMENDATION_STATES,
  WEEKLY_REVIEW_STATUSES,
  WEEKLY_REVIEW_VERSION_STATUSES,
} from "../constants.js";
import type { AdapterReadinessProbe } from "./adapter-readiness.js";
import type { ModelAssuranceSummary } from "./model-assurance.js";

export type WeeklyReviewStatus = (typeof WEEKLY_REVIEW_STATUSES)[number];
export type WeeklyReviewVersionStatus = (typeof WEEKLY_REVIEW_VERSION_STATUSES)[number];
export type WeeklyReviewFindingCategory = (typeof WEEKLY_REVIEW_FINDING_CATEGORIES)[number];
export type WeeklyReviewFindingSeverity = (typeof WEEKLY_REVIEW_FINDING_SEVERITIES)[number];
export type WeeklyReviewFindingStatus = (typeof WEEKLY_REVIEW_FINDING_STATUSES)[number];
export type WeeklyReviewRecommendationState = (typeof WEEKLY_REVIEW_RECOMMENDATION_STATES)[number];
export type WeeklyReviewActionStatus = (typeof WEEKLY_REVIEW_ACTION_STATUSES)[number];
export type WeeklyReviewActionKind = (typeof WEEKLY_REVIEW_ACTION_KINDS)[number];
export type WeeklyReviewEventType = (typeof WEEKLY_REVIEW_EVENT_TYPES)[number];
export type WeeklyReviewEventStatus = (typeof WEEKLY_REVIEW_EVENT_STATUSES)[number];

export interface WeeklyReviewSummary {
  findingCounts: Record<string, number>;
  recommendationCounts: Record<string, number>;
  adapterReadiness: AdapterReadinessProbe[];
  modelAssurance: Record<string, ModelAssuranceSummary>;
}

export interface WeeklyReviewEvent {
  id: string;
  reviewId: string | null;
  versionId: string | null;
  companyId: string;
  eventType: WeeklyReviewEventType;
  status: WeeklyReviewEventStatus;
  actorUserId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  inputCounts: Record<string, number> | null;
  debugMetadata: Record<string, unknown> | null;
  expiresAt: string | null;
  createdAt: string;
}
