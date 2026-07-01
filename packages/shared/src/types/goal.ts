import type { GoalLevel, GoalStatus } from "../constants.js";
import type { Issue } from "./issue.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  linkedIssues?: Issue[];
  linkedIssueIdentifiers?: string[];
  linkedIssueCount?: number;
  createdAt: Date;
  updatedAt: Date;
}
