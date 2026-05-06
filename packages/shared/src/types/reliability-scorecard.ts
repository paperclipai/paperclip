import type { ReliabilityScorecardStatus } from "../constants.js";

export interface ReliabilityScorecardWindow {
  from: string;
  to: string;
}

export interface ReliabilityScorecardSummary {
  status: ReliabilityScorecardStatus;
  controlPlaneReliability: number;
  evidenceCompletenessRate: number;
  manualRescueCount: number;
}

export interface ReliabilityScorecardMetric {
  key: string;
  label: string;
  value: number;
  unit?: string | null;
}

export interface ReliabilityScorecardBlocker {
  class: string;
  count: number;
  blockedMinutes?: number | null;
}

export interface ReliabilityScorecardDocument {
  version: 1;
  generatedAt: string;
  companyId?: string | null;
  window: ReliabilityScorecardWindow;
  summary: ReliabilityScorecardSummary;
  metrics: ReliabilityScorecardMetric[];
  topBlockers: ReliabilityScorecardBlocker[];
}
