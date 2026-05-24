export const BRIEFING_FEEDBACK_RATINGS = ["yes", "somewhat", "no"] as const;
export type BriefingFeedbackRating = (typeof BRIEFING_FEEDBACK_RATINGS)[number];

export const BRIEFING_FEEDBACK_CATEGORIES = [
  "inaccurate_info",
  "missing_section",
  "hard_to_read",
  "late_delivery",
  "other",
] as const;
export type BriefingFeedbackCategory = (typeof BRIEFING_FEEDBACK_CATEGORIES)[number];

export interface BriefingFeedback {
  id: string;
  briefingId: string;
  userId: string;
  rating: BriefingFeedbackRating;
  category: BriefingFeedbackCategory | null;
  freeText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BriefingFeedbackCreate {
  briefingId: string;
  userId: string;
  rating: BriefingFeedbackRating;
  category?: BriefingFeedbackCategory | null;
  freeText?: string | null;
}

export interface FeedbackTrends {
  totalCount: number;
  ratingBreakdown: { rating: BriefingFeedbackRating; count: number }[];
  categoryBreakdown: { category: BriefingFeedbackCategory | null; count: number }[];
  recentFeedback: BriefingFeedback[];
}
