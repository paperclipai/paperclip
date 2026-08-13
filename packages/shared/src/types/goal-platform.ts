import type { RoadmapBlockStatus } from "../constants.js";

export interface GoalTarget {
  id: string;
  companyId: string;
  goalId: string;
  parentId: string | null;
  text: string;
  checked: boolean;
  sortOrder: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface GoalRelation {
  id: string;
  companyId: string;
  type: "serves";
  fromGoalId: string;
  toGoalId: string | null;
  toTargetId: string | null;
  createdAt: Date | string;
}

export interface RoadmapBlock {
  id: string;
  companyId: string;
  title: string;
  detail: string | null;
  status: RoadmapBlockStatus;
  x: number;
  y: number;
  linkedGoalId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface RoadmapBlockEdge {
  id: string;
  companyId: string;
  fromBlockId: string;
  toBlockId: string;
  createdAt: Date | string;
}

export interface RoadmapResponse {
  blocks: RoadmapBlock[];
  edges: RoadmapBlockEdge[];
}
