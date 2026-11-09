import type { Request, Response } from "express";
import type { SecretBindingTargetType } from "@paperclipai/shared";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { responsibleUserAuthzShadowMode } from "../services/authorization.js";

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

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export const BOARD_ACCESS_REQUIRED_CODE = "board_access_required";

// Agent API subresources whose controls live on their own profile tab.
const AGENT_PROFILE_TABS: Record<string, [string, string]> = {
  keys: ["API keys", "api-keys"],
  permissions: ["permissions", "permissions"],
  budgets: ["budget", "budgets"],
  identity: ["identity and instructions", "identity"],
  "instructions-bundle": ["identity and instructions", "identity"],
  "instructions-path": ["identity and instructions", "identity"],
  configuration: ["harness settings", "runtime"],
  "runtime-state": ["harness settings", "runtime"],
};

// The board page that holds the control behind a board-only API route, when one
// is known. Paths keep <prefix> for the agent to fill from its own task identifier.
const BOARD_CONTROL_PAGES: Array<[RegExp, (match: RegExpExecArray) => [string, string]]> = [
  [/^\/(?:companies\/[^/]+\/)?secrets?(?:[-/]|$)/, () => ["company secrets", "/<prefix>/company/settings/secrets"]],
  [/^\/companies\/[^/]+\/(?:budgets|budget-incidents|costs)(?:\/|$)/, () => ["budgets", "/<prefix>/activity/budgets"]],
  [/^\/companies\/[^/]+\/(?:prompt-injection-prevention|decision-model)(?:\/|$)/, () => ["connection settings", "/<prefix>/company/settings/connections"]],
  [/^\/companies\/[^/]+\/(?:members|invites|join-requests)(?:\/|$)/, () => ["company members", "/<prefix>/company/settings/members"]],
  [/^\/companies\/[^/]+\/(?:tools\/)?gateways(?:\/|$)|^\/tool-gateway\//, () => ["tool gateways", "/<prefix>/apps/gateways"]],
  [/^\/approvals\/([^/]+)/, match => ["the approval", `/<prefix>/approvals/${match[1]}`]],
  [/^\/agents\/([0-9a-f-]{36})(?:\/([^/]+))?(?:\/|$)/i, match => {
    const tab = match[2] && Object.hasOwn(AGENT_PROFILE_TABS, match[2]) ? AGENT_PROFILE_TABS[match[2]] : undefined;
    return tab ? [`the agent's ${tab[0]}`, `/<prefix>/agents/${match[1]}/${tab[1]}`] : ["the agent's profile", `/<prefix>/agents/${match[1]}`];
  }],
  [/^\/companies\/[^/]+(?:\/(?:archive|branding|settings))?\/?$/, () => ["company settings", "/<prefix>/company/settings"]],
];

function boardControlPage(req: Request) {
  const path = (req.originalUrl ?? "").split("?")[0]!.replace(/^\/api(?=\/)/, "");
  for (const [pattern, page] of BOARD_CONTROL_PAGES) {
    const match = pattern.exec(path);
    if (match) return page(match);
  }
  return null;
}

/**
 * A board-only denial. Agents get a final, actionable remediation so they hand the
 * action to the person instead of searching other routes for one that does not exist.
 */
export function boardAccessRequired(req: Request) {
  if (req.actor.type !== "agent") return forbidden("Board access required");
  const page = boardControlPage(req);
  const where = page
    ? `They can do it in the Paperclip web app: link [Open ${page[0]}](${page[1]}), with this conversation's company prefix as <prefix>.`
    : "They can do it in the Paperclip web app or with their own board credentials. Link a page only if you already know its route; do not search for one.";
  return forbidden("Board access required", {
    code: BOARD_ACCESS_REQUIRED_CODE,
    remediation: `This action is board-only by design and this denial is final: no agent credential, tool or other API route can do it, so do not search for one. Tell the person that a board user must do it. ${where}`,
  });
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw boardAccessRequired(req);
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
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
  return (req.actor.companyIds ?? []).includes(companyId);
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
