import { api } from "./client";

export interface Announcement {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  body: string;
  visibility: string;
  documentType: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const announcementsApi = {
  list: (companyId: string) =>
    api.get<Announcement[]>(`/companies/${companyId}/announcements`),

  create: (companyId: string, data: { title: string; body?: string }) =>
    api.post<Announcement>(`/companies/${companyId}/announcements`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/announcements/${id}`),
};
