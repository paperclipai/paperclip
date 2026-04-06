import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { forbidden, unauthorized } from "../errors.js";

export type CompanyRole = "owner" | "admin" | "operator" | "viewer";

const ROLE_HIERARCHY: Record<CompanyRole, number> = {
  owner: 4,
  admin: 3,
  operator: 2,
  viewer: 1,
};

export function roleRank(role: string): number {
  return ROLE_HIERARCHY[role as CompanyRole] ?? 0;
}

export function meetsMinRole(userRole: string, minRole: CompanyRole): boolean {
  return roleRank(userRole) >= roleRank(minRole);
}

/**
 * Returns Express middleware that checks the current user's company role
 * against a minimum required role.
 *
 * The companyId is read from `req.params.companyId`.
 *
 * In `local_trusted` mode (source === "local_implicit") all requests are
 * treated as having the "owner" role.
 */
export function requireRole(db: Db, minRole: CompanyRole) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // In local trusted mode, treat all requests as owner
    if (req.actor.source === "local_implicit") {
      next();
      return;
    }

    if (req.actor.type === "none") {
      throw unauthorized();
    }

    // Instance admins are treated as owners
    if (req.actor.isInstanceAdmin) {
      next();
      return;
    }

    const companyId = req.params.companyId as string | undefined;
    if (!companyId) {
      throw forbidden("Missing companyId in path");
    }

    const userId = req.actor.userId;
    if (!userId) {
      throw forbidden("User authentication required for role check");
    }

    const membership = await db
      .select({ role: companyMemberships.role, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!membership || membership.status !== "active") {
      throw forbidden("You are not an active member of this company");
    }

    if (!meetsMinRole(membership.role, minRole)) {
      throw forbidden(
        `Requires at least "${minRole}" role. Your role is "${membership.role}".`,
      );
    }

    next();
  };
}
