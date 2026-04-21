import type { AgentAdapterType, JoinRequest, PermissionKey } from "@paperclipai/shared";
import { api } from "./client";

export type HumanCompanyRole = "owner" | "admin" | "operator" | "viewer";

type InviteSummary = {
  id: string;
  companyId: string | null;
  companyName?: string | null;
  companyLogoUrl?: string | null;
  companyBrandColor?: string | null;
  inviteType: "company_join" | "bootstrap_ceo";
  allowedJoinTypes: "human" | "agent" | "both";
  humanRole?: HumanCompanyRole | null;
  expiresAt: string;
  onboardingPath?: string;
  onboardingUrl?: string;
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  skillIndexPath?: string;
  skillIndexUrl?: string;
  inviteMessage?: string | null;
  invitedByUserName?: string | null;
  joinRequestStatus?: JoinRequest["status"] | null;
  joinRequestType?: JoinRequest["requestType"] | null;
};

type AcceptInviteInput =
  | { requestType: "human" }
  | {
    requestType: "agent";
    agentName: string;
    adapterType?: AgentAdapterType;
    capabilities?: string | null;
    agentDefaultsPayload?: Record<string, unknown> | null;
  };

type AgentJoinRequestAccepted = JoinRequest & {
  claimSecret: string;
  claimApiKeyPath: string;
  onboarding?: Record<string, unknown>;
  diagnostics?: Array<{
    code: string;
    level: "info" | "warn";
    message: string;
    hint?: string;
  }>;
};

type InviteOnboardingManifest = {
  invite: InviteSummary;
  onboarding: {
    inviteMessage?: string | null;
    connectivity?: {
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: {
        method?: string;
        path?: string;
        url?: string;
      };
    };
    textInstructions?: {
      url?: string;
    };
  };
};

type BoardClaimStatus = {
  status: "available" | "claimed" | "expired";
  requiresSignIn: boolean;
  expiresAt: string | null;
  claimedByUserId: string | null;
};

type CliAuthChallengeStatus = {
  id: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  command: string;
  clientName: string | null;
  requestedAccess: "board" | "instance_admin_required";
  requestedCompanyId: string | null;
  requestedCompanyName: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  approvedByUser: { id: string; name: string; email: string } | null;
  requiresSignIn: boolean;
  canApprove: boolean;
  currentUserId: string | null;
};

type CompanyInviteCreated = {
  id: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  allowedJoinTypes: "human" | "agent" | "both";
  humanRole?: HumanCompanyRole | null;
  companyName?: string | null;
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  inviteMessage?: string | null;
};

export type CompanyMemberGrant = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  permissionKey: PermissionKey;
  scope: Record<string, unknown> | null;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanyMember = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  status: "pending" | "active" | "suspended" | "archived";
  membershipRole: HumanCompanyRole | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; email: string | null; name: string | null; image: string | null } | null;
  grants: CompanyMemberGrant[];
  removal?: {
    canArchive: boolean;
    reason: string | null;
  };
};

export type ArchiveCompanyMemberResponse = {
  member: CompanyMember;
  reassignedIssueCount: number;
};

export type CompanyMembersResponse = {
  members: CompanyMember[];
  access: {
    currentUserRole: HumanCompanyRole | null;
    canManageMembers: boolean;
    canInviteUsers: boolean;
    canApproveJoinRequests: boolean;
  };
};

export type CompanyUserDirectoryEntry = {
  principalId: string;
  status: "active";
  user: { id: string; email: string | null; name: string | null; image: string | null } | null;
};

export type CompanyUserDirectoryResponse = {
  users: CompanyUserDirectoryEntry[];
};

export type CompanyInviteRecord = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  inviteType: "company_join" | "bootstrap_ceo";
  allowedJoinTypes: "human" | "agent" | "both";
  humanRole: HumanCompanyRole | null;
  defaultsPayload: Record<string, unknown> | null;
  expiresAt: string;
  invitedByUserId: string | null;
  revokedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  inviteMessage: string | null;
  state: "active" | "revoked" | "accepted" | "expired";
  invitedByUser: { id: string; email: string | null; name: string | null; image: string | null } | null;
  relatedJoinRequestId: string | null;
};

export type CompanyInviteListResponse = {
  invites: CompanyInviteRecord[];
  nextOffset: number | null;
};

export type CompanyJoinRequest = JoinRequest & {
  requesterUser: { id: string; email: string | null; name: string | null; image: string | null } | null;
  approvedByUser: { id: string; email: string | null; name: string | null; image: string | null } | null;
  rejectedByUser: { id: string; email: string | null; name: string | null; image: string | null } | null;
  invite: {
    id: string;
    inviteType: "company_join" | "bootstrap_ceo";
    allowedJoinTypes: "human" | "agent" | "both";
    humanRole: HumanCompanyRole | null;
    inviteMessage: string | null;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
    acceptedAt: string | null;
    invitedByUser: { id: string; email: string | null; name: string | null; image: string | null } | null;
  } | null;
};

export type AdminUserDirectoryEntry = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isInstanceAdmin: boolean;
  activeCompanyMembershipCount: number;
};

export type UserCompanyAccessEntry = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  status: "pending" | "active" | "suspended" | "archived";
  membershipRole: HumanCompanyRole | "member" | null;
  createdAt: string;
  updatedAt: string;
  companyName: string | null;
  companyStatus: "active" | "paused" | "archived" | null;
};

export type UserCompanyAccessResponse = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    isInstanceAdmin: boolean;
  } | null;
  companyAccess: UserCompanyAccessEntry[];
};

export type CurrentBoardAccess = {
  user: { id: string; email: string | null; name: string | null; image: string | null } | null;
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  source: string;
  keyId: string | null;
};

function buildInviteListQuery(options: {
  state?: "active" | "revoked" | "accepted" | "expired";
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const accessApi = {
  createCompanyInvite: (
    companyId: string,
    input: {
      allowedJoinTypes?: "human" | "agent" | "both";
      humanRole?: HumanCompanyRole | null;
      defaultsPayload?: Record<string, unknown> | null;
      agentMessage?: string | null;
    } = {},
  ) =>
    api.post<CompanyInviteCreated>(`/companies/${companyId}/invites`, input),

  createOpenClawInvitePrompt: (
    companyId: string,
    input: {
      agentMessage?: string | null;
    } = {},
  ) =>
    api.post<CompanyInviteCreated>(
      `/companies/${companyId}/openclaw/invite-prompt`,
      input,
    ),

  getInvite: (token: string) => api.get<InviteSummary>(`/invites/${token}`),
  getInviteOnboarding: (token: string) =>
    api.get<InviteOnboardingManifest>(`/invites/${token}/onboarding`),

  acceptInvite: (token: string, input: AcceptInviteInput) =>
    api.post<AgentJoinRequestAccepted | JoinRequest | { bootstrapAccepted: true; userId: string }>(
      `/invites/${token}/accept`,
      input,
    ),

  listInvites: (
    companyId: string,
    options: {
      state?: "active" | "revoked" | "accepted" | "expired";
      limit?: number;
      offset?: number;
    } = {},
  ) =>
    api.get<CompanyInviteListResponse>(
      `/companies/${companyId}/invites${buildInviteListQuery(options)}`,
    ),

  revokeInvite: (inviteId: string) => api.post(`/invites/${inviteId}/revoke`, {}),

  listJoinRequests: (
    companyId: string,
    status: "pending_approval" | "approved" | "rejected" = "pending_approval",
    requestType?: "human" | "agent",
  ) =>
    api.get<CompanyJoinRequest[]>(
      `/companies/${companyId}/join-requests?status=${status}${requestType ? `&requestType=${requestType}` : ""}`,
    ),

  listMembers: (companyId: string) =>
    api.get<CompanyMembersResponse>(`/companies/${companyId}/members`),

  listUserDirectory: (companyId: string) =>
    api.get<CompanyUserDirectoryResponse>(`/companies/${companyId}/user-directory`),

  updateMember: (
    companyId: string,
    memberId: string,
    input: {
      membershipRole?: HumanCompanyRole | null;
      status?: "pending" | "active" | "suspended";
    },
  ) => api.patch<CompanyMember>(`/companies/${companyId}/members/${memberId}`, input),

  updateMemberPermissions: (
    companyId: string,
    memberId: string,
    input: {
      grants: Array<{
        permissionKey: PermissionKey;
        scope?: Record<string, unknown> | null;
      }>;
    },
  ) => api.patch<CompanyMember>(`/companies/${companyId}/members/${memberId}/permissions`, input),

  updateMemberAccess: (
    companyId: string,
    memberId: string,
    input: {
      membershipRole?: HumanCompanyRole | null;
      status?: "pending" | "active" | "suspended";
      grants: Array<{
        permissionKey: PermissionKey;
        scope?: Record<string, unknown> | null;
      }>;
    },
  ) => api.patch<CompanyMember>(`/companies/${companyId}/members/${memberId}/role-and-grants`, input),

  archiveMember: (
    companyId: string,
    memberId: string,
    input: {
      reassignment?: {
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
      } | null;
    } = {},
  ) => api.post<ArchiveCompanyMemberResponse>(`/companies/${companyId}/members/${memberId}/archive`, input),

  approveJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(`/companies/${companyId}/join-requests/${requestId}/approve`, {}),

  rejectJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(`/companies/${companyId}/join-requests/${requestId}/reject`, {}),

  claimJoinRequestApiKey: (requestId: string, claimSecret: string) =>
    api.post<{ keyId: string; token: string; agentId: string; createdAt: string }>(
      `/join-requests/${requestId}/claim-api-key`,
      { claimSecret },
    ),

  getBoardClaimStatus: (token: string, code: string) =>
    api.get<BoardClaimStatus>(`/board-claim/${token}?code=${encodeURIComponent(code)}`),

  claimBoard: (token: string, code: string) =>
    api.post<{ claimed: true; userId: string }>(`/board-claim/${token}/claim`, { code }),

  getCliAuthChallenge: (id: string, token: string) =>
    api.get<CliAuthChallengeStatus>(`/cli-auth/challenges/${id}?token=${encodeURIComponent(token)}`),

  approveCliAuthChallenge: (id: string, token: string) =>
    api.post<{ approved: boolean; status: string; userId: string; keyId: string | null; expiresAt: string }>(
      `/cli-auth/challenges/${id}/approve`,
      { token },
    ),

  cancelCliAuthChallenge: (id: string, token: string) =>
    api.post<{ cancelled: boolean; status: string }>(`/cli-auth/challenges/${id}/cancel`, { token }),

  searchAdminUsers: (query: string) =>
    api.get<AdminUserDirectoryEntry[]>(`/admin/users?query=${encodeURIComponent(query)}`),

  promoteInstanceAdmin: (userId: string) =>
    api.post(`/admin/users/${userId}/promote-instance-admin`, {}),

  demoteInstanceAdmin: (userId: string) =>
    api.post(`/admin/users/${userId}/demote-instance-admin`, {}),

  getUserCompanyAccess: (userId: string) =>
    api.get<UserCompanyAccessResponse>(`/admin/users/${userId}/company-access`),

  setUserCompanyAccess: (userId: string, companyIds: string[]) =>
    api.put<UserCompanyAccessResponse>(`/admin/users/${userId}/company-access`, { companyIds }),

  getCurrentBoardAccess: () =>
    api.get<CurrentBoardAccess>("/cli-auth/me"),
};
