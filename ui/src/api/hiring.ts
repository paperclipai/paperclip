import { api } from "./client";

export interface HiringRequest {
  id: string;
  companyId: string;
  title: string;
  role: string;
  department: string | null;
  employmentType: string;
  justification: string | null;
  status: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  fulfilledAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const hiringApi = {
  list: (companyId: string) =>
    api.get<HiringRequest[]>(`/companies/${companyId}/hiring-requests`),

  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<HiringRequest>(`/companies/${companyId}/hiring-requests`, data),

  update: (companyId: string, id: string, data: Record<string, unknown>) =>
    api.patch<HiringRequest>(`/companies/${companyId}/hiring-requests/${id}`, data),

  fulfill: (companyId: string, id: string, data: Record<string, unknown>) =>
    api.post<HiringRequest>(`/companies/${companyId}/hiring-requests/${id}/fulfill`, data),
};
