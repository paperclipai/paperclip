import type { DeliverableDetail, DeliverableListItem } from "@paperclipai/shared";
import { api } from "./client";

export interface DeliverableListResponse {
  items: DeliverableListItem[];
  limit: number;
  offset: number;
}

export interface DeliverableListFilters {
  limit?: number;
  offset?: number;
  projectId?: string;
  agentId?: string;
  q?: string;
}

export const deliverablesApi = {
  list: (companyId: string, filters?: DeliverableListFilters) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.q) params.set("q", filters.q);
    const qs = params.toString();
    return api.get<DeliverableListResponse>(
      `/companies/${companyId}/deliverables${qs ? `?${qs}` : ""}`,
    );
  },
  get: (id: string) => api.get<DeliverableDetail>(`/deliverables/${id}`),
};
