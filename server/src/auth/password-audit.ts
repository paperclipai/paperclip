import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, NextFunction } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts, authPasswordChangeLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * CMP-60: better-auth does not expose hooks around `account.password` writes.
 * This wrapper sits in front of the better-auth handler at
 * `app.all("/api/auth/{*authPath}", ...)` and:
 *
 *   1. detects password-write endpoints (change / reset / set / sign-up-email),
 *   2. captures the actor + request context BEFORE the handler runs,
 *   3. emits a structured `[AUTH_AUDIT]` log line regardless of outcome,
 *   4. inserts an append-only row into `account_password_change_log`,
 *   5. on success, stamps the actor fields on the target `account` row so the
 *      "who last touched this password" question is answerable from the row
 *      itself, not just from the log tail.
 *
 * Security note: this is observation-only. It does NOT change auth logic,
 * hashing, verification, or session issuance. Failures inside the audit path
 * must never block the underlying auth request — they are logged and dropped.
 */

// HTTP-exposed password-write endpoints in better-auth 1.6.20.
// `/set-password` is currently server-only (createAuthEndpoint.serverOnly),
// so the wrapper will not observe it today — kept as defense-in-depth in
// case a future better-auth release exposes it.
const PASSWORD_WRITE_PATHS = [
  "/api/auth/change-password",
  "/api/auth/reset-password",
  "/api/auth/set-password",
  "/api/auth/sign-up/email",
] as const;

const PASSWORD_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type PasswordWritePath = (typeof PASSWORD_WRITE_PATHS)[number];

function normalizePath(path: string): string {
  // Strip query string and collapse trailing slash.
  const withoutQuery = path.split("?", 1)[0];
  return withoutQuery.endsWith("/") && withoutQuery.length > 1
    ? withoutQuery.slice(0, -1)
    : withoutQuery;
}

function matchPasswordWritePath(method: string, path: string): PasswordWritePath | null {
  if (!PASSWORD_WRITE_METHODS.has(method.toUpperCase())) return null;
  const normalized = normalizePath(path);
  for (const candidate of PASSWORD_WRITE_PATHS) {
    if (normalized === candidate) return candidate;
  }
  return null;
}

function resolveActorFields(actor: Request["actor"] | undefined): {
  actorType: string;
  actorUserId: string | null;
  actorAgentId: string | null;
  actorSource: string | null;
} {
  if (!actor) {
    return { actorType: "none", actorUserId: null, actorAgentId: null, actorSource: null };
  }
  return {
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorAgentId: actor.agentId ?? null,
    actorSource: actor.source ?? null,
  };
}

function resolveIpAddress(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",", 1)[0]?.trim();
    if (first) return first;
  }
  if (req.socket?.remoteAddress) return req.socket.remoteAddress;
  return req.ip ?? null;
}

function resolveUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua.length > 0 ? ua : null;
}

export type PasswordAuditOptions = {
  db: Db;
  enabled: boolean;
};

export type AuditContext = {
  action: PasswordWritePath;
  method: string;
  requestPath: string;
  occurredAt: Date;
  actor: Request["actor"] | undefined;
  ipAddress: string | null;
  userAgent: string | null;
};

async function persistAuditRow(
  db: Db,
  ctx: AuditContext,
  statusCode: number,
  errorMessage: string | null,
): Promise<void> {
  const success = statusCode >= 200 && statusCode < 400;
  const actorFields = resolveActorFields(ctx.actor);

  // The target user is the actor for self-service flows (change-password).
  // For token-based flows (reset-password, sign-up), the actor may be `none`
  // and the target must be resolved from the response/DB later — we record
  // what we can without leaking PII (no password bodies, no email).
  const targetUserId = actorFields.actorType === "board" ? actorFields.actorUserId : null;

  await db.insert(authPasswordChangeLog).values({
    id: randomUUID(),
    accountId: null,
    targetUserId,
    actorType: actorFields.actorType,
    actorUserId: actorFields.actorUserId,
    actorAgentId: actorFields.actorAgentId,
    actorSource: actorFields.actorSource,
    action: ctx.action,
    method: ctx.method,
    requestPath: ctx.requestPath,
    statusCode,
    success,
    errorMessage,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    occurredAt: ctx.occurredAt,
  });

  // Stamp the target account row so the "who last touched this password"
  // question is answerable directly from `account` without joining the log.
  if (success && targetUserId) {
    await db
      .update(authAccounts)
      .set({
        lastPasswordChangedByUserId: actorFields.actorUserId,
        lastPasswordChangedByAgentId: actorFields.actorAgentId,
        lastPasswordChangeSource: actorFields.actorSource ?? ctx.action,
        lastPasswordChangedAt: ctx.occurredAt,
      })
      .where(eq(authAccounts.userId, targetUserId));
  }
}

/**
 * Wrap a better-auth Express RequestHandler with password-write audit instrumentation.
 *
 * When `enabled` is false (e.g. tests that opt out), returns a pass-through
 * wrapper identical in behavior to the unwrapped handler.
 */
export function wrapBetterAuthHandlerWithPasswordAudit(
  handler: RequestHandler,
  opts: PasswordAuditOptions,
): RequestHandler {
  if (!opts.enabled) {
    return (req, res, next) => {
      void Promise.resolve(handler(req, res, next)).catch(next);
    };
  }

  return async (req, res, next) => {
    const match = matchPasswordWritePath(req.method, req.originalUrl || req.url);
    if (!match) {
      try {
        await handler(req, res, next);
      } catch (err) {
        next(err);
      }
      return;
    }

    // Capture context BEFORE the handler — `req.actor` and headers stay stable,
    // but resolving them once avoids re-reading after the response is flushed.
    const ctx: AuditContext = {
      action: match,
      method: req.method,
      requestPath: req.originalUrl || req.url,
      occurredAt: new Date(),
      actor: req.actor,
      ipAddress: resolveIpAddress(req),
      userAgent: resolveUserAgent(req),
    };

    let statusCode = 0;
    let errorMessage: string | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const complete = () => resolve();
        Promise.resolve(handler(req, res, complete as NextFunction)).then(complete, reject);
      });
      statusCode = res.statusCode;
    } catch (err) {
      statusCode = res.statusCode || 500;
      errorMessage = err instanceof Error ? err.message : String(err);
      void emitAudit(opts.db, ctx, statusCode, errorMessage);
      next(err);
      return;
    }

    void emitAudit(opts.db, ctx, statusCode, errorMessage);
  };
}

async function emitAudit(
  db: Db,
  ctx: AuditContext,
  statusCode: number,
  errorMessage: string | null,
): Promise<void> {
  const actorFields = resolveActorFields(ctx.actor);
  logger.info(
    {
      tag: "AUTH_AUDIT",
      action: ctx.action,
      method: ctx.method,
      path: ctx.requestPath,
      statusCode,
      actorType: actorFields.actorType,
      actorUserId: actorFields.actorUserId,
      actorSource: actorFields.actorSource,
      ipAddress: ctx.ipAddress,
    },
    `[AUTH_AUDIT] ${ctx.method} ${ctx.action} ${statusCode}`,
  );

  try {
    await persistAuditRow(db, ctx, statusCode, errorMessage);
  } catch (err) {
    // The auth request itself has already completed. Audit persistence
    // failure must not propagate to the response — record and move on.
    logger.warn(
      { err, action: ctx.action, statusCode },
      "[AUTH_AUDIT] failed to persist password change audit row",
    );
  }
}

// Exported for unit tests.
export const __testing__ = {
  matchPasswordWritePath,
  normalizePath,
  resolveActorFields,
  resolveIpAddress,
  PASSWORD_WRITE_PATHS,
};
