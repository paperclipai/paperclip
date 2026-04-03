import { api } from "./client";

export interface GoalKeyResult {
  id: string;
  goalId: string;
  companyId: string;
  description: string;
  targetValue: string;
  currentValue: string;
  unit: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKeyResultInput {
  description: string;
  targetValue?: string;
  unit?: string;
}

export interface UpdateKeyResultInput {
  description?: string;
  targetValue?: string;
  currentValue?: string;
  unit?: string;
}

export const goalKeyResultsApi = {
  list: (companyId: string, goalId: string) =>
    api.get<GoalKeyResult[]>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/key-results`,
    ),

  create: (companyId: string, goalId: string, data: CreateKeyResultInput) =>
    api.post<GoalKeyResult>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/key-results`,
      data,
    ),

  update: (companyId: string, goalId: string, krId: string, data: UpdateKeyResultInput) =>
    api.patch<GoalKeyResult>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(krId)}`,
      data,
    ),

  remove: (companyId: string, goalId: string, krId: string) =>
    api.delete<GoalKeyResult>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/key-results/${encodeURIComponent(krId)}`,
    ),
};
