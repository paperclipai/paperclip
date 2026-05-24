export const BRIEFING_QUALITY_LABELS = ["premium", "standard", "degraded", "failed"] as const;
export type BriefingQualityLabel = (typeof BRIEFING_QUALITY_LABELS)[number];

export const BRIEFING_QUALITY_DIMENSIONS = [
  "accuracy",
  "completeness",
  "timeliness",
  "clarity_presentation",
  "operational_usefulness",
] as const;
export type BriefingQualityDimension = (typeof BRIEFING_QUALITY_DIMENSIONS)[number];

export interface BriefingDimensionScore {
  dimension: BriefingQualityDimension;
  score: number;
  details: string;
}

export interface BriefingGateResult {
  gateId: string;
  dimension: BriefingQualityDimension;
  passed: boolean;
  details: string;
}

export interface BriefingQualityClassification {
  briefingId: string;
  overallScore: number;
  label: BriefingQualityLabel;
  dimensionScores: BriefingDimensionScore[];
  gateResults: BriefingGateResult[];
  createdAt: Date;
}

export interface BriefingQualityRecord {
  id: string;
  briefingId: string;
  overallScore: number;
  label: BriefingQualityLabel;
  dimensionScores: BriefingDimensionScore[];
  gateResults: BriefingGateResult[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BriefingQualitySummary {
  totalClassified: number;
  labelBreakdown: { label: BriefingQualityLabel; count: number }[];
  averageScore: number;
  recentResults: BriefingQualityClassification[];
}

export const BRIEFING_QUALITY_GATES: {
  id: string;
  dimension: BriefingQualityDimension;
  description: string;
  phase1: boolean;
}[] = [
  { id: "A1", dimension: "accuracy", description: "Flight/date/route match data sources", phase1: true },
  { id: "A2", dimension: "accuracy", description: "Times match schedule", phase1: true },
  { id: "A3", dimension: "accuracy", description: "Aircraft type matches assignment", phase1: true },
  { id: "A4", dimension: "accuracy", description: "Crew manifest cross-reference", phase1: true },
  { id: "A5", dimension: "accuracy", description: "Weather data source validation", phase1: false },
  { id: "A6", dimension: "accuracy", description: "NOTAM accuracy cross-check", phase1: false },
  { id: "A8", dimension: "accuracy", description: "Fuel/weight data integrity", phase1: false },
  { id: "B1", dimension: "completeness", description: "All required sections present", phase1: false },
  { id: "B9", dimension: "completeness", description: "No boilerplate/placeholder content", phase1: true },
  { id: "D2", dimension: "timeliness", description: "Within 2h delivery window", phase1: true },
  { id: "D3", dimension: "timeliness", description: "Data source freshness within limits", phase1: true },
  { id: "D4", dimension: "timeliness", description: "No stale cached data", phase1: true },
  { id: "E2", dimension: "operational_usefulness", description: "Briefing supports operational decisions", phase1: false },
];

export const BRIEFING_MANDATORY_GATE_IDS = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A8",
  "B1", "B9",
  "D2", "D3", "D4",
  "E2",
];
