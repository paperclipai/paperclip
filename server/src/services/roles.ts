import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyRolePermissions,
  companyRoles,
  departments,
  principalRoleAssignments,
} from "@paperclipai/db";
import type {
  PermissionKey,
  PermissionScope,
  PrincipalType,
} from "@paperclipai/shared";
import { permissionScopeSchema } from "@paperclipai/shared";
import { accessService } from "./access.js";
import { badRequest, conflict, notFound } from "../errors.js";

type SystemRoleDefinition = {
  key: string;
  name: string;
  description: string;
  permissionKeys: PermissionKey[];
};

const SYSTEM_ROLE_DEFINITIONS: SystemRoleDefinition[] = [
  {
    key: "company_admin",
    name: "Company Admin",
    description: "Company-wide administrator with full Phase 2 access controls.",
    permissionKeys: [
      "roles:view",
      "roles:manage",
      "departments:view",
      "departments:manage",
      "teams:view",
      "teams:manage",
      "agents:view",
      "agents:manage",
      "projects:view",
      "projects:manage",
      "issues:view",
      "issues:manage",
      "org:view",
      "users:invite",
      "users:manage_permissions",
      "joins:approve",
      "agents:create",
      "tasks:assign",
    ],
  },
  {
    key: "department_manager",
    name: "Department Manager",
    description: "Department-scoped manager role for teams, issues, projects, and assignments.",
    permissionKeys: [
      "roles:view",
      "departments:view",
      "teams:view",
      "agents:view",
      "projects:view",
      "projects:manage",
      "issues:view",
      "issues:manage",
      "org:view",
      "tasks:assign",
    ],
  },
  {
    key: "department_member",
    name: "Department Member",
    description: "Department-scoped contributor role with read access and issue execution rights.",
    permissionKeys: [
      "departments:view",
      "teams:view",
      "agents:view",
      "projects:view",
      "issues:view",
      "issues:manage",
      "org:view",
    ],
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only company or department access.",
    permissionKeys: [
      "departments:view",
      "teams:view",
      "agents:view",
      "projects:view",
      "issues:view",
      "org:view",
    ],
  },
];

function parsePermissionScope(raw: unknown): PermissionScope {
  const parsed = permissionScopeSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

export function rolesService(db: Db) {
  const access = accessService(db);

  async function normalizeScope(companyId: string, scope: PermissionScope): Promise<PermissionScope> {
    if (scope === null) return null;
    if (scope.kind !== "departments") return scope;

    const departmentIds = [...new Set(scope.departmentIds)].sort();
    const rows = await db
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          eq(departments.companyId, companyId),
          eq(departments.status, "active"),
          inArray(departments.id, departmentIds),
        ),
      );

    if (rows.length !== departmentIds.length) {
      throw badRequest("Role assignment scope must reference active departments in the same company");
    }

    return {
      ...scope,
      departmentIds,
    };
  }

  async function listRoles(companyId: string) {
    const roles = await db
      .select()
      .from(companyRoles)
      .where(eq(companyRoles.companyId, companyId))
      .orderBy(companyRoles.isSystem, companyRoles.name);

    if (roles.length === 0) return [];

    const permissions = await db
      .select()
      .from(companyRolePermissions)
      .where(inArray(companyRolePermissions.roleId, roles.map((role) => role.id)));

    const permissionKeysByRole = new Map<string, PermissionKey[]>();
    for (const permission of permissions) {
      const keys = permissionKeysByRole.get(permission.roleId) ?? [];
      keys.push(permission.permissionKey as PermissionKey);
      permissionKeysByRole.set(permission.roleId, keys);
    }

    return roles.map((role) => ({
      ...role,
      permissionKeys: (permissionKeysByRole.get(role.id) ?? []).sort(),
    }));
  }

  async function getRoleById(roleId: string) {
    const role = await db
      .select()
      .from(companyRoles)
      .where(eq(companyRoles.id, roleId))
      .then((rows) => rows[0] ?? null);
    if (!role) return null;

    const permissionRows = await db
      .select()
      .from(companyRolePermissions)
      .where(eq(companyRolePermissions.roleId, roleId));

    return {
      ...role,
      permissionKeys: permissionRows
        .map((permission) => permission.permissionKey as PermissionKey)
        .sort(),
    };
  }

  async function createRole(
    companyId: string,
    input: {
      key: string;
      name: string;
      description?: string | null;
      permissionKeys: PermissionKey[];
      isSystem?: boolean;
    },
  ) {
    try {
      const [role] = await db
        .insert(companyRoles)
        .values({
          companyId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          isSystem: input.isSystem ?? false,
        })
        .returning();

      await syncRolePermissions(role.id, input.permissionKeys);
      return getRoleById(role.id);
    } catch (error) {
      if (error instanceof Error && error.message.includes("company_roles_company_key_uq")) {
        throw conflict(`Role key "${input.key}" already exists in this company`);
      }
      if (error instanceof Error && error.message.includes("company_roles_company_name_uq")) {
        throw conflict(`Role name "${input.name}" already exists in this company`);
      }
      throw error;
    }
  }

  async function updateRole(
    roleId: string,
    input: {
      name?: string;
      description?: string | null;
      status?: "active" | "archived";
      permissionKeys?: PermissionKey[];
    },
  ) {
    const existing = await db
      .select()
      .from(companyRoles)
      .where(eq(companyRoles.id, roleId))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Role not found");

    try {
      await db
        .update(companyRoles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(companyRoles.id, roleId));

      if (input.permissionKeys) {
        await syncRolePermissions(roleId, input.permissionKeys);
      }
      return getRoleById(roleId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("company_roles_company_name_uq")) {
        throw conflict(`Role name "${input.name}" already exists in this company`);
      }
      throw error;
    }
  }

  async function archiveRole(roleId: string) {
    const updated = await updateRole(roleId, { status: "archived" });
    if (!updated) throw notFound("Role not found");
    return updated;
  }

  async function listRoleAssignments(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    const assignments = await db
      .select()
      .from(principalRoleAssignments)
        .where(
          and(
            eq(principalRoleAssignments.companyId, companyId),
            eq(principalRoleAssignments.principalType, principalType),
            eq(principalRoleAssignments.principalId, principalId),
        ),
      );

    if (assignments.length === 0) return [];
    const roles = await listRoles(companyId);
    const roleById = new Map(roles.map((role) => [role.id, role]));

    return assignments.map((assignment) => ({
      ...assignment,
      scope: parsePermissionScope(assignment.scope),
      role: roleById.get(assignment.roleId) ?? null,
        }));
  }

  async function getRoleAssignmentById(companyId: string, assignmentId: string) {
    const assignment = await db
      .select()
      .from(principalRoleAssignments)
      .where(
        and(
          eq(principalRoleAssignments.companyId, companyId),
          eq(principalRoleAssignments.id, assignmentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!assignment) return null;

    const [role] = await Promise.all([
      getRoleById(assignment.roleId),
    ]);

    return {
      ...assignment,
      scope: parsePermissionScope(assignment.scope),
      role,
    };
  }

  async function assignRole(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    roleId: string,
    scope: PermissionScope,
    assignedByUserId: string | null,
  ) {
    const role = await db
      .select()
      .from(companyRoles)
      .where(and(eq(companyRoles.id, roleId), eq(companyRoles.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!role) throw notFound("Role not found");

    await access.ensureMembership(companyId, principalType, principalId, "member", "active");
    const normalizedScope = await normalizeScope(companyId, scope);

    try {
      const [assignment] = await db
        .insert(principalRoleAssignments)
        .values({
          companyId,
          roleId,
          principalType,
          principalId,
          scope: normalizedScope,
          assignedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            principalRoleAssignments.companyId,
            principalRoleAssignments.roleId,
            principalRoleAssignments.principalType,
            principalRoleAssignments.principalId,
          ],
          set: {
            scope: normalizedScope,
            assignedByUserId,
            updatedAt: new Date(),
          },
        })
        .returning();

      return assignment;
    } catch (error) {
      if (error instanceof Error && error.message.includes("principal_role_assignments_company_role_principal_uq")) {
        throw conflict("This role is already assigned to the principal");
      }
      throw error;
    }
  }

  async function removeRoleAssignment(companyId: string, assignmentId: string) {
    const removed = await db
      .delete(principalRoleAssignments)
      .where(
        and(
          eq(principalRoleAssignments.companyId, companyId),
          eq(principalRoleAssignments.id, assignmentId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!removed) throw notFound("Role assignment not found");
    return removed;
  }

  async function seedSystemRoles(companyId: string) {
    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const existing = await db
        .select()
        .from(companyRoles)
        .where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.key, definition.key)))
        .then((rows) => rows[0] ?? null);

      const role = existing
        ? await updateRole(existing.id, {
            name: definition.name,
            description: definition.description,
            status: "active",
            permissionKeys: definition.permissionKeys,
          })
        : await createRole(companyId, {
            key: definition.key,
            name: definition.name,
            description: definition.description,
            permissionKeys: definition.permissionKeys,
            isSystem: true,
          });

      if (!role) throw notFound(`Failed to seed role ${definition.key}`);
      if (!existing && !role.isSystem) {
        await db
          .update(companyRoles)
          .set({ isSystem: true, updatedAt: new Date() })
          .where(eq(companyRoles.id, role.id));
      }
    }

    return listRoles(companyId);
  }

  async function syncRolePermissions(roleId: string, permissionKeys: PermissionKey[]) {
    const nextKeys = [...new Set(permissionKeys)].sort();
    const existing = await db
      .select()
      .from(companyRolePermissions)
      .where(eq(companyRolePermissions.roleId, roleId));

    const existingKeys = new Set(existing.map((permission) => permission.permissionKey as PermissionKey));
    const nextKeySet = new Set(nextKeys);

    const toDelete = existing
      .filter((permission) => !nextKeySet.has(permission.permissionKey as PermissionKey))
      .map((permission) => permission.id);
    if (toDelete.length > 0) {
      await db.delete(companyRolePermissions).where(inArray(companyRolePermissions.id, toDelete));
    }

    const toInsert = nextKeys.filter((permissionKey) => !existingKeys.has(permissionKey));
    if (toInsert.length > 0) {
      await db.insert(companyRolePermissions).values(
        toInsert.map((permissionKey) => ({
          roleId,
          permissionKey,
        })),
      );
    }
  }

  return {
    seedSystemRoles,
    listRoles,
    getRoleById,
    getRoleAssignmentById,
    createRole,
    updateRole,
    archiveRole,
    assignRole,
    removeRoleAssignment,
    listRoleAssignments,
  };
}
