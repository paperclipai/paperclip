import type { Request, Response, NextFunction, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { verifyAdminOverrideJwt, type AdminOverrideJwtClaims } from "../admin-override-jwt.js";
import { logger } from "./logger.js";

export interface AdminOverrideContext {
  jti: string;
  principalUserId: string;
  reason: string;
  originIp: string;
  userAgent: string | null;
  jwtIat: Date;
  jwtExp: Date;
}

export interface StatusGuardContext {
  requestId: string;
  peTransactionId?: string;
  adminOverride?: AdminOverrideContext;
}

declare global {
  namespace Express {
    interface Request {
      statusGuard?: StatusGuardContext;
    }
  }
}

const GOVERNED_FIELDS = ["status", "assigneeAgentId", "assigneeUserId", "completedAt", "track"] as const;

const DEFAULT_LEGAL_PATHS = [
  "POST /functions/v1/policy-engine (preferred)",
  "PATCH with blockReason to block",
  "X-Admin-Override: <CEO-scoped JWT> for break-glass",
];

function isStatusGuardEnabled() {
  const raw = process.env.PAPERCLIP_STATUS_GUARD_V2?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function bodyTouchesGovernedFields(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return GOVERNED_FIELDS.some((key) => key in record);
}

function getIssueIdFromRequest(req: Request): string | null {
  const fromParams = (req.params as Record<string, unknown> | undefined)?.id;
  return typeof fromParams === "string" && fromParams.length > 0 ? fromParams : null;
}

function getNonEmptyString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function respondDenied(
  res: Response,
  status: number,
  payload: Record<string, unknown>,
) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

type ExistingIssueLookup = (issueId: string) => Promise<{ status: string } | null>;

export interface StatusTransitionOptions {
  getIssueStatus: ExistingIssueLookup;
}

/**
 * Layer 1 status-transition guard (AKS-1509 §7.3 / AKS-1597).
 *
 * Gated behind PAPERCLIP_STATUS_GUARD_V2 (default false — dormant no-op).
 * When enabled, rejects any PATCH that mutates status / assignee / completedAt /
 * track unless one of five allowlisted exceptions holds (A backlog, B block,
 * C unblock, D PE-authored, E CEO break-glass JWT).
 */
export function enforceStatusTransition(options: StatusTransitionOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isStatusGuardEnabled()) return next();
    if (req.method !== "PATCH") return next();

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!bodyTouchesGovernedFields(body)) return next();

    const requestIdHeader = req.header("x-request-id");
    const requestId =
      typeof requestIdHeader === "string" && /^[\w\-:.]{1,128}$/.test(requestIdHeader)
        ? requestIdHeader
        : randomUUID();
    const issueId = getIssueIdFromRequest(req);
    if (!issueId) return next();

    const existing = await options.getIssueStatus(issueId);
    if (!existing) return next();

    const fromStatus = existing.status;
    const toStatusRaw = body["status"];
    const toStatus =
      typeof toStatusRaw === "string" && toStatusRaw.length > 0 ? toStatusRaw : fromStatus;

    const guardContext: StatusGuardContext = { requestId };
    req.statusGuard = guardContext;

    // Exception A: backlog maintenance (backlog <-> todo)
    const backlogSet = new Set(["backlog", "todo"]);
    if (backlogSet.has(fromStatus) && backlogSet.has(toStatus)) return next();

    // Exception B: * -> blocked with non-empty blockReason
    if (toStatus === "blocked" && getNonEmptyString(body, "blockReason")) return next();

    // Exception C: blocked -> * with non-empty unblockReason
    if (fromStatus === "blocked" && getNonEmptyString(body, "unblockReason")) return next();

    // Exception D: PE-authored via X-PE-Transition-Id.
    //
    // Per AKS-1591 LCSO protocol, the consume is a two-transaction autonomous-commit pattern
    // running on the shared Supabase `transition_artifacts` table (project rqrnplaswseoytjrhmcs).
    // That client is not yet plumbed into this server. When enabled without the client wired,
    // Exception D must fail-closed with 503 so callers treat the header as burned-not-retryable.
    //
    // Implementation of the consume + precise-error mapping lands alongside the shared-Supabase
    // client wiring (tracked as a sibling to this PR — see AKS-1597 progress comment).
    const peTransitionId = req.header("x-pe-transition-id");
    if (peTransitionId && peTransitionId.length > 0) {
      logger.warn(
        {
          event: "status_guard.pe_consume_unavailable",
          requestId,
          issueId,
          fromStatus,
          toStatus,
        },
        "PE-authored transition received but shared-Supabase consume path is not wired. Fail-closed.",
      );
      respondDenied(res, 503, {
        error: "pe_artifact_verification_unavailable",
        message:
          "Exception D consume path not available. Shared-Supabase transition_artifacts client is not wired in this build. Retry when operational note clears.",
        request_id: requestId,
      });
      return;
    }

    // Exception E: CEO break-glass JWT.
    const rawOverride = req.header("x-admin-override");
    if (rawOverride === "true") {
      respondDenied(res, 422, {
        error: "admin_override_boolean_form_retired",
        message:
          "Use a CEO-scoped override JWT. See AKS-1509 §4 Exception E / AKS-1597 REV-A.",
        request_id: requestId,
      });
      return;
    }

    if (rawOverride && rawOverride.length > 0) {
      const result = verifyAdminOverrideJwt(rawOverride);
      if (!result.ok) {
        respondDenied(res, 422, {
          error: result.error,
          message: "Admin override JWT rejected.",
          request_id: requestId,
        });
        return;
      }
      const claims: AdminOverrideJwtClaims = result.claims;
      if (
        claims.issue_id !== issueId ||
        claims.old_status !== fromStatus ||
        claims.new_status !== toStatus
      ) {
        respondDenied(res, 422, {
          error: "admin_override_bounds_mismatch",
          message:
            "Admin override JWT issue_id/old_status/new_status must bind exactly to the requested transition.",
          request_id: requestId,
        });
        return;
      }

      const originIp = req.ip ?? "";
      const userAgent = req.header("user-agent") ?? null;
      guardContext.adminOverride = {
        jti: claims.jti,
        principalUserId: claims.sub,
        reason: claims.reason,
        originIp,
        userAgent,
        jwtIat: new Date(claims.iat * 1000),
        jwtExp: new Date(claims.exp * 1000),
      };
      return next();
    }

    // No exception matched — deny with actionable error shape.
    respondDenied(res, 422, {
      error: "status_transition_blocked",
      message: "PATCH status requires Policy Engine. See AKS-685 / AKS-1509.",
      legalPaths: DEFAULT_LEGAL_PATHS,
      request_id: requestId,
    });
  };
}

export const __testing = {
  isStatusGuardEnabled,
  bodyTouchesGovernedFields,
};
