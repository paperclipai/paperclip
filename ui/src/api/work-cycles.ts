import type { CreateWorkCycle, UpdateWorkCycle, WorkCycle } from "@paperclipai/shared";
import { api } from "./client";

export const workCyclesApi = {
  list: (
    companyId: string,
    filters?: {
      projectId?: string | null;
      includeCompanyWide?: boolean;
      includeArchived?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.includeCompanyWide === false) params.set("includeCompanyWide", "false");
    if (filters?.includeArchived) params.set("includeArchived", "true");
    const qs = params.toString();
    return api.get<WorkCycle[]>(`/companies/${companyId}/work-cycles${qs ? `?${qs}` : ""}`);
  },
  create: (companyId: string, data: CreateWorkCycle) =>
    api.post<WorkCycle>(`/companies/${companyId}/work-cycles`, data),
  update: (id: string, data: UpdateWorkCycle) =>
    api.patch<WorkCycle>(`/work-cycles/${id}`, data),
};
