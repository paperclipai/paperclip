import type { GoalLevel, GoalStatus } from "../constants.js";

export type GoalHealthStatus = "on_track" | "at_risk" | "off_track" | "achieved" | "no_data";
export type GoalCadence = "weekly" | "monthly" | "quarterly" | "annual" | "custom";
export type GoalType = "committed" | "aspirational";
export type CheckInStatus = "on_track" | "at_risk" | "off_track" | "achieved" | "cancelled";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  targetDate: string | null;
  confidence: number | null;
  healthScore: number | null;
  healthStatus: GoalHealthStatus | null;
  startDate: string | null;
  cadence: GoalCadence | null;
  goalType: GoalType | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalCheckIn {
  id: string;
  goalId: string;
  companyId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  progressPercent: string | null;
  confidence: number | null;
  status: CheckInStatus;
  note: string | null;
  blockers: string | null;
  nextSteps: string | null;
  createdAt: Date;
}

export interface GoalSnapshot {
  id: string;
  goalId: string;
  companyId: string;
  snapshotDate: string;
  progressPercent: string | null;
  healthScore: number | null;
  confidence: number | null;
  totalIssues: number | null;
  completedIssues: number | null;
  blockedIssues: number | null;
  budgetSpentCents: bigint | null;
  createdAt: Date;
}
