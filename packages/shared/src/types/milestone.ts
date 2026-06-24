export interface Milestone {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMilestoneInput {
  name: string;
  projectId?: string | null;
  description?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
}

export interface UpdateMilestoneInput {
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
  projectId?: string | null;
}
