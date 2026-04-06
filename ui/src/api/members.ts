import { api } from "./client";

export interface CompanyMember {
  id: string;
  companyId: string;
  principalType: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
  role: string;
  invitedBy: string | null;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
}

export const membersApi = {
  list: (companyId: string) =>
    api.get<CompanyMember[]>(`/companies/${companyId}/members`),

  invite: (companyId: string, data: { email: string; role: string }) =>
    api.post<CompanyMember>(`/companies/${companyId}/members/invite`, data),

  changeRole: (companyId: string, userId: string, role: string) =>
    api.patch<CompanyMember>(`/companies/${companyId}/members/${userId}/role`, { role }),

  remove: (companyId: string, userId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/members/${userId}`),
};
