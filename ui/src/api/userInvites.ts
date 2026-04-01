import type { MembershipRole } from "@ironworksai/shared";
import { api } from "./client";

export interface UserInviteRecord {
  id: string;
  companyId: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface UserInviteCreated {
  id: string;
  email: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
}

export interface UserInvitePublic {
  id: string;
  companyId: string;
  email: string;
  role: string;
  expiresAt: string;
}

export interface MeAccessInfo {
  isInstanceAdmin: boolean;
  memberships: Array<{
    companyId: string;
    role: string;
    status: string;
  }>;
}

export const userInvitesApi = {
  create: (companyId: string, data: { email: string; role?: MembershipRole }) =>
    api.post<UserInviteCreated>(`/companies/${companyId}/user-invites`, data),

  list: (companyId: string) =>
    api.get<UserInviteRecord[]>(`/companies/${companyId}/user-invites`),

  getByToken: (token: string) =>
    api.get<UserInvitePublic>(`/user-invites/${token}`),

  accept: (token: string, data: { name: string; password: string; tosAccepted: boolean }) =>
    api.post<{ accepted: boolean; userId: string; companyId: string }>(
      `/user-invites/${token}/accept`,
      data,
    ),

  revoke: (companyId: string, inviteId: string) =>
    api.post<{ revoked: boolean }>(
      `/companies/${companyId}/user-invites/${inviteId}/revoke`,
      {},
    ),
};

export const meAccessApi = {
  get: () => api.get<MeAccessInfo>("/me/access"),
};

export const memberApi = {
  updateRole: (companyId: string, memberId: string, role: MembershipRole) =>
    api.patch<{ id: string; membershipRole: string }>(
      `/companies/${companyId}/members/${memberId}/role`,
      { role },
    ),
};
