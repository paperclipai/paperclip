import type {
  CompanyRoleStatus,
  PermissionKey,
  PermissionScopeKind,
  PrincipalType,
} from "../constants.js";

export interface DepartmentPermissionScope {
  kind: Extract<PermissionScopeKind, "departments">;
  departmentIds: string[];
  includeDescendants: boolean;
}

export type PermissionScope = DepartmentPermissionScope | null;

export interface CompanyRole {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  status: CompanyRoleStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyRolePermission {
  id: string;
  roleId: string;
  permissionKey: PermissionKey;
  createdAt: Date;
}

export interface PrincipalRoleAssignment {
  id: string;
  companyId: string;
  roleId: string;
  principalType: PrincipalType;
  principalId: string;
  scope: PermissionScope;
  assignedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyRoleWithPermissions extends CompanyRole {
  permissionKeys: PermissionKey[];
}

export interface PrincipalRoleAssignmentDetail extends PrincipalRoleAssignment {
  role: CompanyRoleWithPermissions;
}
