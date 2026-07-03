import type { GoalLevel, GoalStatus } from "../constants.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  // Metric tracking — numeric columns come back as strings from postgres-js to
  // preserve precision; the UI parses them for the on-target health calculation.
  // Optional so older fixtures/seed data without these columns still satisfy the
  // type; the API always returns them (null when unset).
  metricTarget?: string | null;
  metricCurrent?: string | null;
  metricUnit?: string | null;
  targetDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
