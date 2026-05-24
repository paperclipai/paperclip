export type ReReviewTriggerReason = "no_rating" | "three_somewhat" | "three_no" | "investigation";
export type ReReviewStatus = "pending" | "in_progress" | "completed";
export type EscalationLevel = "watch" | "warning" | "alert" | "critical";

export interface QualityScoreAdjustment {
  id: string;
  briefingId: string;
  userId: string;
  rating: string;
  dimension: string;
  adjustmentAmount: number;
  previousScore: number;
  newScore: number;
  adjustmentSource: string;
  reReviewTriggered: ReReviewTriggerReason | null;
  tierChanged: string | null;
  escalationLevel: EscalationLevel | null;
  createdAt: Date;
}

export interface ReReviewQueueItem {
  id: string;
  briefingId: string;
  userId: string;
  rating: string;
  triggerReason: ReReviewTriggerReason;
  status: ReReviewStatus;
  assignedReviewerId: string | null;
  dueAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CrewRatingFlag {
  id: string;
  userId: string;
  ratingType: "somewhat" | "no";
  count: number;
  windowStart: Date;
  lastTriggeredAt: Date | null;
  createdAt: Date;
}

export interface ScoreAdjustmentResult {
  adjustment: QualityScoreAdjustment;
  previousLabel: string;
  newLabel: string;
  tierChanged: boolean;
  reReviewTriggered: ReReviewTriggerReason | null;
  reReviewItem: ReReviewQueueItem | null;
  escalationLevel: EscalationLevel | null;
}
