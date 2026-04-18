import type { Goal } from "@paperclipai/shared";
import { api } from "./client";

export const goalsApi = {
  list: (companyId: string) => api.get<Goal[]>(`/companies/${companyId}/goals`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (companyId: string, goalId: string, data: Record<string, unknown>) =>
    api.patch<Goal>(`/companies/${companyId}/goals/${goalId}`, data),
  remove: (companyId: string, goalId: string) =>
    api.delete<Goal>(`/companies/${companyId}/goals/${goalId}`),
};
