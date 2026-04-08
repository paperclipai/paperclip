import { z } from "zod";
import {
  COMPANY_ROLE_STATUSES,
  PERMISSION_KEYS,
  PERMISSION_SCOPE_KINDS,
} from "../constants.js";

export const departmentPermissionScopeSchema = z.object({
  kind: z.literal(PERMISSION_SCOPE_KINDS[0]),
  departmentIds: z.array(z.string().uuid()).min(1),
  includeDescendants: z.boolean().default(false),
});

export const permissionScopeSchema = z.union([
  departmentPermissionScopeSchema,
  z.null(),
]);

export const permissionGrantSchema = z.object({
  permissionKey: z.enum(PERMISSION_KEYS),
  scope: permissionScopeSchema.optional().nullable(),
});

export const companyRoleStatusSchema = z.enum(COMPANY_ROLE_STATUSES);

export const createCompanyRoleSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional().nullable(),
  permissionKeys: z.array(z.enum(PERMISSION_KEYS)).min(1),
});

export const updateCompanyRoleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional().nullable(),
  status: companyRoleStatusSchema.optional(),
  permissionKeys: z.array(z.enum(PERMISSION_KEYS)).min(1).optional(),
});

export const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
  scope: permissionScopeSchema.optional().nullable(),
});

export type DepartmentPermissionScopeInput = z.infer<typeof departmentPermissionScopeSchema>;
export type PermissionScopeInput = z.infer<typeof permissionScopeSchema>;
export type PermissionGrantInput = z.infer<typeof permissionGrantSchema>;
export type CreateCompanyRole = z.infer<typeof createCompanyRoleSchema>;
export type UpdateCompanyRole = z.infer<typeof updateCompanyRoleSchema>;
export type AssignRole = z.infer<typeof assignRoleSchema>;
