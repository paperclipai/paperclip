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
import type { PermissionScope } from "./rbac.js";
import type { CompanyRoleWithPermissions, PrincipalRoleAssignmentDetail } from "./rbac.js";

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

export interface EffectivePermissionSummary {
  permissionKey: PermissionKey;
  companyWide: boolean;
  departmentIds: string[];
}

export interface MembershipPrincipalSummary {
  id: string;
  type: PrincipalType;
  name: string;
  email: string | null;
  title: string | null;
  status: string | null;
  urlKey: string | null;
}

export interface CompanyMembershipAccessSummary extends CompanyMembership {
  principal: MembershipPrincipalSummary;
  directGrants: PrincipalPermissionGrant[];
  roleAssignments: PrincipalRoleAssignmentDetail[];
  effectivePermissions: EffectivePermissionSummary[];
}

export interface PrincipalPermissionGrant {
  id: string;
  companyId: string;
  principalType: PrincipalType;
  principalId: string;
  permissionKey: PermissionKey;
  scope: PermissionScope;
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
