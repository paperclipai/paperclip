import type { WorkCycleStatus } from "../constants.js";
import type { Project } from "./project.js";

export interface WorkCycle {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: WorkCycleStatus;
  startDate: string | null;
  endDate: string | null;
  capacityStoryPoints: number | null;
  capacityHours: number | null;
  project?: Project | null;
  createdAt: Date;
  updatedAt: Date;
}
