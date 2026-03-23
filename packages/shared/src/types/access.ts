import type {
  AgentAdapterType,
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
  grants?: PermissionKey[];
  displayName?: string | null;
  email?: string | null;
  image?: string | null;
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

export interface InstanceUserRoleGrant {
  id: string;
  userId: string;
  role: InstanceUserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  role: string;
  addedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPermissionGrant {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  permissionKey: string;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgent {
  id: string;
  projectId: string;
  companyId: string;
  agentId: string;
  addedByUserId: string | null;
  createdAt: string;
}
