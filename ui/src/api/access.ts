import type { AgentAdapterType, JoinRequest } from "@paperclipai/shared";
import { api, ApiError } from "./client";

type InviteSummary = {
  id: string;
  companyId: string | null;
  inviteType: "company_join" | "bootstrap_ceo";
  allowedJoinTypes: "human" | "agent" | "both";
  expiresAt: string;
  onboardingPath?: string;
  onboardingUrl?: string;
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  skillIndexPath?: string;
  skillIndexUrl?: string;
  inviteMessage?: string | null;
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

type CompanyInviteCreated = {
  id: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  allowedJoinTypes: "human" | "agent" | "both";
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  inviteMessage?: string | null;
};

export const accessApi = {
  createCompanyInvite: (
    companyId: string,
    input: {
      allowedJoinTypes?: "human" | "agent" | "both";
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

  listJoinRequests: (companyId: string, status: "pending_approval" | "approved" | "rejected" = "pending_approval") =>
    api.get<JoinRequest[]>(`/companies/${companyId}/join-requests?status=${status}`),

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

  listMembers: (companyId: string) =>
    api.get<Array<{
      id: string;
      companyId: string;
      principalType: "user" | "agent";
      principalId: string;
      status: "active" | "suspended";
      membershipRole: string | null;
      createdAt: string;
      updatedAt: string;
    }>>(`/companies/${companyId}/members`),

  updateMemberPermissions: (
    companyId: string,
    memberId: string,
    grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
  ) =>
    api.patch<{
      id: string;
      companyId: string;
      principalType: "user" | "agent";
      principalId: string;
      status: string;
      membershipRole: string | null;
    }>(`/companies/${companyId}/members/${memberId}/permissions`, { grants }),

  removeMember: async (companyId: string, memberId: string) => {
    const res = await fetch(`/api/companies/${companyId}/members/${memberId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new ApiError(
        (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
        res.status,
        errorBody,
      );
    }
  },

  suspendMember: (companyId: string, memberId: string) =>
    api.post<{
      id: string;
      status: "suspended";
      membershipRole: string | null;
    }>(`/companies/${companyId}/members/${memberId}/suspend`, {}),

  unsuspendMember: (companyId: string, memberId: string) =>
    api.post<{
      id: string;
      status: "active";
      membershipRole: string | null;
    }>(`/companies/${companyId}/members/${memberId}/unsuspend`, {}),

  revokeInvite: (inviteId: string) =>
    api.post<{ revoked: true }>(`/invites/${inviteId}/revoke`, {}),

  listPeople: (companyId: string) =>
    api.get<Array<{
      id: string;
      name: string;
      email: string;
      avatar: string | null;
      membershipRole: string | null;
      status: string;
    }>>(`/companies/${companyId}/people`),

  getMyPermissions: (companyId: string) =>
    api.get<{
      membershipRole: string | null;
      permissions: string[];
    }>(`/companies/${companyId}/my-permissions`),

  sendInviteEmail: (
    companyId: string,
    inviteId: string,
    input: { email: string; token: string },
  ) =>
    api.post<{ sent: true; to: string }>(
      `/companies/${companyId}/invites/${inviteId}/send-email`,
      input,
    ),
};
