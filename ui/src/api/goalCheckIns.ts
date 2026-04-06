import type { GoalCheckIn } from "@ironworksai/shared";
import { api } from "./client";

export interface CreateCheckInPayload {
  status: string;
  confidence?: number;
  note?: string;
  blockers?: string;
  nextSteps?: string;
  progressPercent?: string;
}

export const goalCheckInsApi = {
  list: (companyId: string, goalId: string) =>
    api.get<GoalCheckIn[]>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/check-ins`,
    ),

  create: (companyId: string, goalId: string, data: CreateCheckInPayload) =>
    api.post<GoalCheckIn>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/check-ins`,
      data,
    ),
};
