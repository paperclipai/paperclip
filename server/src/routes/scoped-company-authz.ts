import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";

type ResolvedDepartmentScope = {
  companyWide: boolean;
  departmentIds: string[];
  principalType: PrincipalType;
  principalId: string;
};

function isLocalImplicitBoard(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

export function scopedCompanyAuthz(db: Db) {
  const access = accessService(db);

  function formatPermissionList(permissionKeys: readonly PermissionKey[]) {
    return permissionKeys.join(" or ");
  }

  function uniquePermissionKeys(permissionKeys: readonly PermissionKey[]) {
    return [...new Set(permissionKeys)];
  }

  async function resolvePrincipalScope(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    return access.resolveAccessibleDepartmentIds(
      companyId,
      principalType,
      principalId,
      permissionKey,
    );
  }

  function resolveActorPrincipal(req: Request): { principalType: PrincipalType; principalId: string } {
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      return {
        principalType: "agent",
        principalId: req.actor.agentId,
      };
    }

    if (req.actor.type === "board") {
      if (!req.actor.userId) throw unauthorized();
      return {
        principalType: "user",
        principalId: req.actor.userId,
      };
    }

    throw unauthorized();
  }

  async function resolveScopedPermission(
    req: Request,
    companyId: string,
    permissionKey: PermissionKey,
  ): Promise<ResolvedDepartmentScope> {
    return resolveAnyScopedPermission(req, companyId, [permissionKey]);
  }

  async function resolveAnyScopedPermission(
    req: Request,
    companyId: string,
    permissionKeys: readonly PermissionKey[],
  ): Promise<ResolvedDepartmentScope> {
    assertCompanyAccess(req, companyId);

    const uniqueKeys = uniquePermissionKeys(permissionKeys);
    if (uniqueKeys.length === 0) {
      throw forbidden("At least one permission key is required");
    }

    if (isLocalImplicitBoard(req) || req.actor.isInstanceAdmin) {
      return {
        companyWide: true,
        departmentIds: [],
        principalType: "user",
        principalId: req.actor.userId ?? "local-board",
      };
    }

    const { principalType, principalId } = resolveActorPrincipal(req);
    const scopes = await Promise.all(
      uniqueKeys.map((permissionKey) =>
        resolvePrincipalScope(companyId, principalType, principalId, permissionKey),
      ),
    );

    const allowedScopes = scopes.filter((scope) => scope.companyWide || scope.departmentIds.length > 0);
    if (allowedScopes.length === 0) {
      throw forbidden(`Missing permission: ${formatPermissionList(uniqueKeys)}`);
    }

    if (allowedScopes.some((scope) => scope.companyWide)) {
      return {
        companyWide: true,
        departmentIds: [],
        principalType,
        principalId,
      };
    }

    return {
      companyWide: false,
      departmentIds: [...new Set(allowedScopes.flatMap((scope) => scope.departmentIds))]
        .sort((left, right) => left.localeCompare(right)),
      principalType,
      principalId,
    };
  }

  async function assertScopedPermission(
    req: Request,
    companyId: string,
    permissionKey: PermissionKey,
    departmentId: string | null | undefined,
  ) {
    const scope = await resolveScopedPermission(req, companyId, permissionKey);
    if (scope.companyWide) return scope;
    if (!departmentId) {
      throw forbidden(`Company-wide ${permissionKey} is required for resources without a department`);
    }
    if (!scope.departmentIds.includes(departmentId)) {
      throw forbidden(`Missing ${permissionKey} access for the requested department`);
    }
    return scope;
  }

  async function assertAnyScopedPermission(
    req: Request,
    companyId: string,
    permissionKeys: readonly PermissionKey[],
    departmentId: string | null | undefined,
  ) {
    const uniqueKeys = uniquePermissionKeys(permissionKeys);
    const scope = await resolveAnyScopedPermission(req, companyId, uniqueKeys);
    if (scope.companyWide) return scope;
    if (!departmentId) {
      throw forbidden(`Company-wide ${formatPermissionList(uniqueKeys)} is required for resources without a department`);
    }
    if (!scope.departmentIds.includes(departmentId)) {
      throw forbidden(`Missing ${formatPermissionList(uniqueKeys)} access for the requested department`);
    }
    return scope;
  }

  return {
    resolveScopedPermission,
    resolveAnyScopedPermission,
    assertScopedPermission,
    assertAnyScopedPermission,
  };
}
