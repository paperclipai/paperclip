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
  createdAt: Date;
  updatedAt: Date;
}

/** task completion counts per goal, for rendering a progress bar */
export interface GoalProgressRow {
  goalId: string;
  totalTasks: number;
  doneTasks: number;
}
