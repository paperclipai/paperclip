import type { BriefingQualityLabel, BriefingQualityClassification } from "./briefing-quality.js";
import type { ReReviewTriggerReason, ReReviewStatus, EscalationLevel } from "./quality-score-adjustments.js";

export interface QualityScorecard {
  companyId: string;
  totalClassified: number;
  labelBreakdown: { label: BriefingQualityLabel; count: number }[];
  averageScore: number;
  recentResults: BriefingQualityClassification[];
}

export interface QualityEscalation {
  id: string;
  briefingId: string;
  rating: string;
  triggerReason: ReReviewTriggerReason;
  status: ReReviewStatus;
  escalationLevel: EscalationLevel | null;
  createdAt: string;
}

export interface QualityMetric {
  period: string;
  averageScore: number;
  totalClassified: number;
  labelCounts: Record<string, number>;
}

export interface QualityMetricsResponse {
  metrics: QualityMetric[];
}

export interface CrewMemberScore {
  id: string;
  name: string;
  image: string | null;
  overall: number;
  accuracy: number;
  timeliness: number;
  completeness: number;
  trend: "up" | "down" | "stable";
  totalBriefings: number;
}

export interface GatePassRate {
  gate: string;
  description: string;
  passed: number;
  failed: number;
  total: number;
}
