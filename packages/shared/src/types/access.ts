import type {
  AgentAdapterType,
  CompanyStatus,
  HumanCompanyMembershipRole,
  InstanceUserRole,
  InviteJoinType,
  InviteType,
  JoinRequestStatus,
  JoinRequestType,
  MembershipStatus,
  PermissionKey,
  PrincipalType,
} from "../constants.js";

export interface CompanyMembership {
  id: string;
  companyId: string;
  principalType: PrincipalType;
  principalId: string;
  status: MembershipStatus;
  membershipRole: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrincipalPermissionGrant {
  id: string;
  companyId: string;
  principalType: PrincipalType;
  principalId: string;
  permissionKey: PermissionKey;
  scope: Record<string, unknown> | null;
  grantedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccessUserProfile {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

export interface CompanyMemberRecord extends CompanyMembership {
  principalType: "user";
  membershipRole: HumanCompanyMembershipRole | null;
  user: AccessUserProfile | null;
  grants: PrincipalPermissionGrant[];
  removal?: {
    canArchive: boolean;
    reason: string | null;
  };
}

export interface CompanyMembersResponse {
  members: CompanyMemberRecord[];
  access: {
    currentUserRole: HumanCompanyMembershipRole | null;
    canManageMembers: boolean;
    canInviteUsers: boolean;
    canApproveJoinRequests: boolean;
  };
}

export interface ArchiveCompanyMemberResponse {
  member: CompanyMemberRecord;
  reassignedIssueCount: number;
}

export interface Invite {
  id: string;
  companyId: string | null;
  inviteType: InviteType;
  tokenHash: string;
  allowedJoinTypes: InviteJoinType;
  defaultsPayload: Record<string, unknown> | null;
  expiresAt: Date;
  invitedByUserId: string | null;
  revokedAt: Date | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InviteState = "active" | "revoked" | "accepted" | "expired";

export interface CompanyInviteRecord extends Invite {
  companyName: string | null;
  humanRole: HumanCompanyMembershipRole | null;
  inviteMessage: string | null;
  state: InviteState;
  invitedByUser: AccessUserProfile | null;
  relatedJoinRequestId: string | null;
}

export interface CompanyInviteListResponse {
  invites: CompanyInviteRecord[];
  nextOffset: number | null;
}

export interface JoinRequest {
  id: string;
  inviteId: string;
  companyId: string;
  requestType: JoinRequestType;
  status: JoinRequestStatus;
  requestIp: string;
  requestingUserId: string | null;
  requestEmailSnapshot: string | null;
  agentName: string | null;
  adapterType: AgentAdapterType | null;
  capabilities: string | null;
  agentDefaultsPayload: Record<string, unknown> | null;
  claimSecretExpiresAt: Date | null;
  claimSecretConsumedAt: Date | null;
  createdAgentId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  rejectedByUserId: string | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JoinRequestInviteSummary {
  id: string;
  inviteType: InviteType;
  allowedJoinTypes: InviteJoinType;
  humanRole: HumanCompanyMembershipRole | null;
  inviteMessage: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
  invitedByUser: AccessUserProfile | null;
}

export interface JoinRequestRecord extends JoinRequest {
  requesterUser: AccessUserProfile | null;
  approvedByUser: AccessUserProfile | null;
  rejectedByUser: AccessUserProfile | null;
  invite: JoinRequestInviteSummary | null;
}

export interface InstanceUserRoleGrant {
  id: string;
  userId: string;
  role: InstanceUserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDirectoryEntry extends AccessUserProfile {
  isInstanceAdmin: boolean;
  activeCompanyMembershipCount: number;
}

export interface UserCompanyAccessEntry extends CompanyMembership {
  principalType: "user";
  companyName: string | null;
  companyStatus: CompanyStatus | null;
}

export interface UserCompanyAccessResponse {
  user: (AccessUserProfile & {
    isInstanceAdmin: boolean;
  }) | null;
  companyAccess: UserCompanyAccessEntry[];
}
