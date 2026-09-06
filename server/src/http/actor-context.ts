import type { AgentApiKeyScope } from "@paperclipai/shared";

export type HttpMembership = {
  companyId: string;
  membershipRole?: string | null;
  status?: string;
};

export type HttpActor =
  | {
      type: "board";
      source: "local_implicit" | "session" | "board_key" | "cloud_tenant";
      userId?: string;
      userName?: string | null;
      userEmail?: string | null;
      companyIds?: string[];
      sessionId?: string | null;
      memberships?: HttpMembership[];
      isInstanceAdmin?: boolean;
      keyId?: string;
      runId?: string;
    }
  | {
      type: "agent";
      source: "agent_key" | "agent_jwt";
      agentId?: string;
      companyId?: string;
      keyId?: string;
      keyScope?: AgentApiKeyScope;
      runId?: string;
      onBehalfOfUserId?: string | null;
      onBehalfOfMemberships?: HttpMembership[];
    }
  | {
      type: "none";
      source: "none";
      runId?: string;
    };

export type CompanyAuthorization =
  | { allowed: true }
  | {
      allowed: false;
      status: 401 | 403;
      message: string;
      code?: "RESPONSIBLE_USER_UNAVAILABLE" | "RESPONSIBLE_USER_UNAUTHORIZED";
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function activeMembership(
  memberships: HttpMembership[] | undefined,
  companyId: string,
): HttpMembership | undefined {
  return memberships?.find(
    (membership) => membership.companyId === companyId && membership.status === "active",
  );
}

/**
 * Pure company-scope authorization policy shared by the future HTTP boundary.
 * Credential resolution remains in the existing auth service; this function
 * only evaluates an already-authenticated actor and never performs I/O.
 */
export function authorizeCompanyAccess(
  actor: HttpActor,
  companyId: string,
  method: string,
): CompanyAuthorization {
  if (actor.type === "none") {
    return { allowed: false, status: 401, message: "Unauthorized" };
  }

  if (actor.type === "agent") {
    if (actor.companyId !== companyId) {
      return {
        allowed: false,
        status: 403,
        message: "Agent key cannot access another company",
      };
    }

    if (actor.onBehalfOfUserId?.trim()) {
      const membership = activeMembership(actor.onBehalfOfMemberships, companyId);
      if (!membership) {
        return {
          allowed: false,
          status: 403,
          code: "RESPONSIBLE_USER_UNAVAILABLE",
          message: "Responsible user is unavailable for this company",
        };
      }
      if (!isSafeMethod(method) && membership.membershipRole === "viewer") {
        return {
          allowed: false,
          status: 403,
          code: "RESPONSIBLE_USER_UNAUTHORIZED",
          message: "Responsible user is not authorized for write access",
        };
      }
    }

    return { allowed: true };
  }

  if (actor.source === "local_implicit") {
    return { allowed: true };
  }

  if (!actor.companyIds?.includes(companyId)) {
    return {
      allowed: false,
      status: 403,
      message: "User does not have access to this company",
    };
  }

  if (!isSafeMethod(method) && !actor.isInstanceAdmin && actor.memberships !== undefined) {
    const membership = activeMembership(actor.memberships, companyId);
    if (!membership) {
      return {
        allowed: false,
        status: 403,
        message: "User does not have active company access",
      };
    }
    if (membership.membershipRole === "viewer") {
      return {
        allowed: false,
        status: 403,
        message: "Viewer access is read-only",
      };
    }
  }

  return { allowed: true };
}
