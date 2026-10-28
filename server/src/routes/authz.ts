import type { Request, Response } from "express";
import type { SecretBindingTargetType } from "@paperclipai/shared";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { responsibleUserAuthzShadowMode } from "../services/authorization.js";
import {
  hasActiveStaffMembership,
  hasClientMembershipFor,
  isClientMembershipRole,
} from "../services/company-member-roles.js";

function throwOrShadowResponsibleUserCompanyAccessDeny(
  req: Request,
  companyId: string,
  code: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE",
  message: string,
) {
  logger.warn({
    authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
    code,
    action: "company_access",
    companyId,
    actorAgentId: req.actor.agentId ?? null,
    responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    method: req.method,
  }, "responsible-user company access intersection denied");
  if (responsibleUserAuthzShadowMode()) return;
  throw new HttpError(403, message, { code });
}

/**
 * Deny-by-default support for the `client` membership role.
 *
 * `client` is not a weaker staff role. It is a principal class whose default
 * surface is empty: every company-scoped core route denies it, and the only
 * things it can reach are the ones that explicitly opt in.
 *
 * The deny lives here, inside the three shared company-scope helpers, rather
 * than at their ~600 call sites. That is deliberate: a per-call-site allowlist
 * could not be reviewed, and any route added later would default to *allow*.
 * Here, a core route that has never heard of clients denies them for free.
 *
 * The opt-in is a request-scoped marker keyed by a module-private `Symbol`.
 * A symbol cannot be produced by JSON body/query parsing, so no amount of
 * request-controlled input can forge the marker; only server code holding a
 * reference to `markCompanyClientReachable` can set it. Default state is
 * unmarked.
 */
const CLIENT_REACHABLE_COMPANY_IDS = Symbol("paperclipClientReachableCompanyIds");

type ClientReachableCarrier = {
  [CLIENT_REACHABLE_COMPANY_IDS]?: Set<string>;
};

/**
 * Mark the current request as permitted to serve a `client` principal for one
 * company. Intended for the plugin route dispatcher, which knows a declared
 * route is client-reachable and has resolved the caller's own client record.
 * Core routes must never call this.
 */
export function markCompanyClientReachable(req: Request, companyId: string) {
  const carrier = req as unknown as ClientReachableCarrier;
  const existing = carrier[CLIENT_REACHABLE_COMPANY_IDS];
  if (existing) {
    existing.add(companyId);
    return;
  }
  // Non-enumerable so the marker never leaks into request logging or any
  // serialization of the request object.
  Object.defineProperty(req, CLIENT_REACHABLE_COMPANY_IDS, {
    value: new Set([companyId]),
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function isCompanyClientReachable(req: Request, companyId: string): boolean {
  const carrier = req as unknown as ClientReachableCarrier;
  return carrier[CLIENT_REACHABLE_COMPANY_IDS]?.has(companyId) ?? false;
}

/**
 * True when the actor's own membership in `companyId` is a `client`
 * membership. Every board actor source populates `actor.memberships`
 * (`session`, `board_key`, `mcp_oauth`, `cloud_tenant`); `local_implicit` is
 * the on-box CLI and is never a company member, so it is excluded before we
 * look. If memberships are absent we report `false`, which preserves today's
 * behavior exactly for the four staff roles rather than denying an actor we
 * cannot classify.
 */
export function isClientMembership(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit") return false;
  return hasClientMembershipFor(req.actor.memberships, companyId);
}

function isClientDenied(req: Request, companyId: string): boolean {
  return isClientMembership(req, companyId) && !isCompanyClientReachable(req, companyId);
}

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  if (!Array.isArray(req.actor.companyIds) || req.actor.companyIds.length === 0) {
    return false;
  }
  // Org-level routes are staff surface, and they are not company-scoped, so
  // `assertCompanyAccess` never runs on them. A principal whose only
  // memberships are `client` memberships is staff nowhere and gets no org
  // access -- without this, the ~100 routes guarded by `assertBoardOrgAccess`
  // and `assertBoardOrAgent` would stay reachable by a client.
  return hasActiveStaffMembership(req.actor.memberships);
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "agent" && req.actor.onBehalfOfUserId?.trim()) {
    const membership = req.actor.onBehalfOfMemberships?.find(
      (item) => item.companyId === companyId && item.status === "active",
    );
    if (!membership) {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAVAILABLE",
        "Responsible user is unavailable for this company",
      );
      return;
    }
    // A client can never lend its authority to an agent, on any method. This
    // is not routed through the shadow-mode helper on purpose: shadow mode
    // exists to roll the responsible-user intersection out over memberships
    // that already exist in the wild, and no deployment can have a `client`
    // membership before this change ships. There is nothing to shadow, and
    // failing open here would undo the deny for every agent-run route.
    if (isClientMembershipRole(membership.membershipRole)) {
      throw forbidden("Client access is limited to client-facing routes");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && membership.membershipRole === "viewer") {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAUTHORIZED",
        "Responsible user is not authorized for write access",
      );
    }
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    // Deny clients on EVERY method, safe ones included. Unlike `viewer`, a
    // client is not a read-only staff member: it has no default read surface
    // at all.
    if (isClientDenied(req, companyId)) {
      throw forbidden("Client access is limited to client-facing routes");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

/**
 * Non-throwing access check for routes that look up a resource by id
 * before responding. Prefer this over `assertCompanyAccess` whenever the
 * route can reach the access check only after a successful `getById`
 * (i.e. after confirming the resource exists).
 *
 * Using `assertCompanyAccess` in that position leaks resource existence
 * across tenants: a 404 means "no such resource" while a 403 means "exists
 * in another tenant". Any authenticated user can enumerate IDs and
 * distinguish the two responses.
 *
 * Most routes should use `getAccessibleResource` below, which wraps the
 * whole pattern. When composing manually (bespoke not-found responses),
 * the shape is:
 *
 *     const issue = await svc.getById(id);
 *     if (!issue || !hasCompanyAccess(req, issue.companyId)) {
 *       res.status(404).json({ error: "Issue not found" });
 *       return;
 *     }
 *
 * so both "does not exist" and "exists but cross-tenant" return the same
 * 404, removing the oracle.
 *
 * Note: this intentionally does not replicate the write-path membership
 * checks in `assertCompanyAccess` (active membership, viewer read-only).
 * Routes that need those checks for authorized tenants should still call
 * `assertCompanyAccess` after the 404 gate — the oracle concern is only
 * about the existence check.
 *
 * The company-scope semantics must stay in lockstep with
 * `assertCompanyAccess`: in particular, signed-in instance admins do NOT
 * get blanket access to companies they are not a member of.
 */
export function hasCompanyAccess(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") return req.actor.companyId === companyId;
  if (req.actor.source === "local_implicit") return true;
  if (!(req.actor.companyIds ?? []).includes(companyId)) return false;
  // A client membership lands in `companyIds` like any other active
  // membership, so the role has to be consulted here too -- otherwise every
  // `getAccessibleResource` call site would hand a client the resource.
  // Returning false (rather than throwing) keeps the tenant-safe 404 and the
  // existing no-existence-oracle property.
  return !isClientDenied(req, companyId);
}

/**
 * Preferred way to fetch a company-scoped resource by id inside a route
 * handler. Wraps the two-step pattern described on `hasCompanyAccess` so
 * new routes cannot accidentally reintroduce the existence oracle:
 *
 *   - missing resource          → 404 `{ error: notFoundMessage }`, returns null
 *   - exists but cross-tenant   → identical 404, returns null
 *   - accessible                → runs `assertCompanyAccess` (write-path
 *     membership checks on non-safe methods) and returns the resource
 *
 * Usage:
 *
 *     const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
 *     if (!goal) return;
 *
 * Routes with bespoke not-found behavior (legacy `200 []` contracts,
 * audit-logged denials) should still compose `hasCompanyAccess` directly.
 */
export async function getAccessibleResource<T extends { companyId: string }>(
  req: Request,
  res: Response,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T | null> {
  const resolved = await resource;
  if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  assertCompanyAccess(req, resolved.companyId);
  return resolved;
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    sessionId: string | null;
    agentId: null;
    runId: string | null;
    agentApiKeyId: null;
    actorSource: "local_implicit" | "session" | "board_key" | "mcp_oauth" | "cloud_tenant";
  }
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    const actorSource = req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key";
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      agentApiKeyId: req.actor.keyId ?? null,
      actorSource,
    };
  }

  const actorSource =
    req.actor.source === "local_implicit" ||
      req.actor.source === "board_key" ||
      req.actor.source === "cloud_tenant" ||
      req.actor.source === "mcp_oauth"
      ? req.actor.source
      : "session";

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    sessionId: req.actor.sessionId ?? null,
    agentId: null,
    runId: req.actor.runId ?? null,
    agentApiKeyId: null,
    actorSource,
  };
}

/**
 * The actor-scoped fields of a secret-binding context, keyed to a caller-supplied
 * consumer identity. Structurally matches `SecretConsumerContext` in
 * `services/secrets.ts` (whose types are not exported), so the return value slots
 * into `resolveAdapterConfigForRuntime`'s 3rd argument
 * (`Omit<SecretBindingContext, "configPath">`) unchanged.
 */
export type ActorSecretContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  actorType: "agent" | "user";
  actorId: string | null;
  actorSource: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "mcp_oauth" | "cloud_tenant";
  responsibleUserId: string | null;
};

/**
 * Build the actor-scoped portion of a secret-binding context from `req.actor`,
 * taking the consumer identity as parameters. The responsible user is derived
 * server-side (`req.actor.userId ?? req.actor.onBehalfOfUserId ?? null`) and is
 * never request-body-controllable; a `null` result surfaces downstream as the
 * intended `responsible_user_missing` loud failure for a required user secret.
 *
 * `consumerType` is a parameter (not hardcoded `"agent"`) so callers can record an
 * honest consumer — `agent` for a persisted agent, `environment`/`system` for a
 * prospective config with no persisted consumer.
 *
 * Never sets `configPath` (the resolver injects it) or `allowedBindingIds`.
 */
export function buildActorSecretContext(
  req: Request,
  params: { consumerType: SecretBindingTargetType; consumerId: string },
): ActorSecretContext {
  const info = getActorInfo(req);
  return {
    consumerType: params.consumerType,
    consumerId: params.consumerId,
    actorType: info.actorType,
    actorId: info.actorId,
    actorSource: info.actorSource,
    responsibleUserId: req.actor.userId ?? req.actor.onBehalfOfUserId ?? null,
  };
}
