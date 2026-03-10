import type { MilestoneStatus, ProjectStatus, WorkspaceCheckoutStatus } from "../constants.js";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  metadata: Record<string, unknown> | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectMilestone {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  description: string | null;
  status: MilestoneStatus;
  targetDate: string | null;
  completedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceCheckout {
  id: string;
  companyId: string;
  projectWorkspaceId: string;
  issueId: string;
  agentId: string;
  lastRunId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  status: WorkspaceCheckoutStatus;
  baseRef: string | null;
  releasedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  milestones?: ProjectMilestone[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
