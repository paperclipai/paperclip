import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import {
  USER_DELEGATE_FOR_HEADER,
  USER_DELEGATE_FOR_QUERY_PARAM,
  USER_DELEGATE_REASON_HEADER,
  USER_DELEGATE_REASON_MAX_LENGTH,
  USER_DELEGATE_REASON_QUERY_PARAM,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { matchUserDelegateAction, userDelegateService } from "../services/user-delegates.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readMarker(req: Request, header: string, queryParam: string): string | null | undefined {
  const fromHeader = req.header(header);
  if (fromHeader !== undefined) return fromHeader.trim();
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.[queryParam];
  if (fromQuery === undefined) return undefined;
  return typeof fromQuery === "string" ? fromQuery.trim() : null;
}

/** Remove the delegate query parameters so routes that validate their query never see them. */
function stripDelegateQuery(req: Request) {
  const queryStart = req.url.indexOf("?");
  if (queryStart < 0) return;
  const params = new URLSearchParams(req.url.slice(queryStart + 1));
  if (!params.has(USER_DELEGATE_FOR_QUERY_PARAM) && !params.has(USER_DELEGATE_REASON_QUERY_PARAM)) return;
  params.delete(USER_DELEGATE_FOR_QUERY_PARAM);
  params.delete(USER_DELEGATE_REASON_QUERY_PARAM);
  const rest = params.toString();
  req.url = req.url.slice(0, queryStart) + (rest ? `?${rest}` : "");
}

/**
 * Lets a person's named delegate agent act as that person on the allowlisted
 * person-only actions in `USER_DELEGATE_ACTIONS`.
 *
 * The agent opts in per request with `X-Paperclip-Delegate-For: <userId>` and
 * `X-Paperclip-Delegate-Reason: <why>` (or the `delegateFor` and
 * `delegateReason` query parameters). The middleware checks that the person
 * named this agent and has not turned it off, that the route is delegatable and
 * that the person can still act in the company. It records the delegate, the
 * person and the reason in the activity log before the action runs, then
 * replaces the actor with a board actor that carries only the person's own
 * membership in this one company and never instance-admin rights.
 *
 * Requests without the marker are untouched.
 */
export function userDelegateActorMiddleware(db: Db): RequestHandler {
  const delegates = userDelegateService(db);
  return async (req, _res, next) => {
    try {
      const userId = readMarker(req, USER_DELEGATE_FOR_HEADER, USER_DELEGATE_FOR_QUERY_PARAM);
      if (userId === undefined) {
        next();
        return;
      }
      const actor = req.actor;
      if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
        throw forbidden("Only an agent can act as a person's delegate", { code: "user_delegate_actor_not_agent" });
      }
      if (!userId) throw badRequest("Name the person the delegate acts for", { code: "user_delegate_user_required" });
      const reason = readMarker(req, USER_DELEGATE_REASON_HEADER, USER_DELEGATE_REASON_QUERY_PARAM);
      if (!reason || reason.length > USER_DELEGATE_REASON_MAX_LENGTH) {
        throw badRequest(`Give a reason of 1 to ${USER_DELEGATE_REASON_MAX_LENGTH} characters for this delegate action`, {
          code: "user_delegate_reason_required",
        });
      }
      if ((actor.keyScope && actor.keyScope.kind !== "standard") || actor.authorizingUserId) {
        throw forbidden("This agent credential cannot act as a delegate", { code: "user_delegate_credential_restricted" });
      }
      const companyId = actor.companyId;
      const agentId = actor.agentId;
      const delegation = await delegates.findActiveForAgent(companyId, userId, agentId);
      if (!delegation) {
        throw forbidden("This agent is not this person's delegate", { code: "user_delegate_not_authorized" });
      }
      const method = req.method.toUpperCase();
      const delegateAction = matchUserDelegateAction(method, req.path);
      if (!delegateAction) {
        throw forbidden("A delegate cannot do this action for the person", { code: "user_delegate_action_not_allowed" });
      }
      const membership = await delegates.getUserMembership(companyId, userId);
      if (!membership || membership.status !== "active" || (!SAFE_METHODS.has(method) && membership.membershipRole === "viewer")) {
        throw forbidden("The person cannot do this action in this company", { code: "user_delegate_user_unavailable" });
      }

      // Record before acting: a failed audit write stops the action.
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: actor.runId ?? null,
        agentApiKeyId: actor.keyId ?? null,
        action: "user_delegate.acted",
        entityType: "user_delegate",
        entityId: delegation.id,
        responsibleUserIdOverride: userId,
        details: {
          onBehalfOfUserId: userId,
          delegateAgentId: agentId,
          reason,
          delegateAction: delegateAction.key,
          method,
          path: req.path,
        },
      });

      req.actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: membership.membershipRole, status: membership.status }],
        isInstanceAdmin: false,
        source: "delegate",
        delegate: {
          delegationId: delegation.id,
          agentId,
          runId: actor.runId ?? null,
          reason,
          action: delegateAction.key,
        },
      };
      stripDelegateQuery(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}
