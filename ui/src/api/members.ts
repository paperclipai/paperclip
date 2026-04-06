import { api } from "./client";

export type CompanyMember = {
  id: string;
  companyId: string;
  principalType: "user" | "agent";
  principalId: string;
  status: string;
  membershipRole: string | null;
  displayName: string;
  email: string | null;
  grants: string[];
  isInstanceAdmin: boolean;
  createdAt: string;
  updatedAt: string;
};

export const membersApi = {
  list: (companyId: string) =>
    api.get<CompanyMember[]>(`/companies/${companyId}/members`),

  updatePermissions: (companyId: string, memberId: string, grants: { permissionKey: string; scope?: Record<string, unknown> | null }[]) =>
    api.patch<CompanyMember>(`/companies/${companyId}/members/${memberId}/permissions`, { grants }),
};
