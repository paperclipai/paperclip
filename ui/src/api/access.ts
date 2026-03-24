import type { AgentAdapterType, CompanyMembership, JoinRequest, PermissionKey } from "@paperclipai/shared";
import { api } from "./client";

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

export const accessApi = {
  getMe: () =>
    api.get<{
      authenticated: boolean;
      type?: "board" | "agent";
      userId?: string | null;
      isInstanceAdmin?: boolean;
      source?: string;
      companies?: string[];
      agentId?: string | null;
      companyId?: string | null;
    }>("/me"),

  createCompanyInvite: (
    companyId: string,
    input: {
      allowedJoinTypes?: "human" | "agent" | "both";
      defaultsPayload?: Record<string, unknown> | null;
      agentMessage?: string | null;
    } = {},
  ) =>
    api.post<{
      id: string;
      token: string;
      inviteUrl: string;
      expiresAt: string;
      allowedJoinTypes: "human" | "agent" | "both";
      onboardingTextPath?: string;
      onboardingTextUrl?: string;
      inviteMessage?: string | null;
    }>(`/companies/${companyId}/invites`, input),

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

  // Lightweight team list for pickers
  listTeam: (companyId: string) =>
    api.get<Array<{ id: string; principalId: string; displayName: string; email: string | null }>>(`/companies/${companyId}/team`),

  // Members & Permissions
  listMembers: (companyId: string) =>
    api.get<CompanyMembership[]>(`/companies/${companyId}/members`),

  updateMemberPermissions: (
    companyId: string,
    memberId: string,
    grants: Array<{ permissionKey: PermissionKey; scope?: Record<string, unknown> | null }>,
  ) =>
    api.patch<CompanyMembership>(
      `/companies/${companyId}/members/${memberId}/permissions`,
      { grants },
    ),

  applyRolePreset: (companyId: string, memberId: string, presetId: string) =>
    api.post<CompanyMembership & { appliedPreset: string }>(
      `/companies/${companyId}/members/${memberId}/role-preset`,
      { presetId },
    ),

  revokeInvite: (inviteId: string) =>
    api.post<{ id: string; revokedAt: string }>(`/invites/${inviteId}/revoke`, {}),

  createHumanInvite: (
    companyId: string,
    input: {
      allowedJoinTypes?: "human" | "agent" | "both";
    } = {},
  ) =>
    api.post<{
      id: string;
      token: string;
      inviteUrl: string;
      expiresAt: string;
      allowedJoinTypes: "human" | "agent" | "both";
    }>(`/companies/${companyId}/invites`, {
      allowedJoinTypes: input.allowedJoinTypes ?? "human",
    }),
};
