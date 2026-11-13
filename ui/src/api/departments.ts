import type { Department } from "@paperclipai/shared";
import { api } from "./client";

export const departmentsApi = {
  list: (companyId: string) => api.get<Department[]>(`/companies/${companyId}/departments`),
  create: (companyId: string, name: string) =>
    api.post<Department>(`/companies/${companyId}/departments`, { name }),
  setForAgent: (agentId: string, departmentIds: string[], names?: string[]) =>
    api.put<Department[]>(`/agents/${agentId}/departments`, {
      departmentIds,
      ...(names && names.length > 0 ? { names } : {}),
    }),
};
