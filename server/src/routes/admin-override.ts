import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  ADMIN_OVERRIDE_CONSTANTS,
  createAdminOverrideJwt,
} from "../admin-override-jwt.js";
import {
  ADMIN_OVERRIDE_RATE_LIMITS,
  AdminOverrideRateLimiter,
} from "../admin-override-rate-limiter.js";

const CEO_REAUTH_WINDOW_SECONDS = 60;

const mintRequestSchema = z.object({
  issueId: z.string().uuid(),
  oldStatus: z.string().min(1),
  newStatus: z.string().min(1),
  reason: z.string().min(ADMIN_OVERRIDE_CONSTANTS.reasonMinLength),
  ttlSeconds: z.number().int().positive().max(ADMIN_OVERRIDE_CONSTANTS.ttlMaxSeconds).optional(),
});

function getConfiguredPrincipals(): Set<string> {
  const raw = process.env.PAPERCLIP_ADMIN_OVERRIDE_PRINCIPALS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
}

export interface AdminOverrideRoutesOptions {
  db: Db;
  rateLimiter?: AdminOverrideRateLimiter;
  nowMs?: () => number;
}

export function adminOverrideRoutes(opts: AdminOverrideRoutesOptions): Router {
  const router = Router();
  const limiter =
    opts.rateLimiter ??
    new AdminOverrideRateLimiter({
      hourlyLimit: ADMIN_OVERRIDE_RATE_LIMITS.hourlyLimit,
      dailyLimit: ADMIN_OVERRIDE_RATE_LIMITS.dailyLimit,
      nowMs: opts.nowMs,
    });
  const now = opts.nowMs ?? (() => Date.now());

  router.post(
    "/admin-override/mint",
    validate(mintRequestSchema),
    async (req: Request, res: Response) => {
      noStore(res);
      const actor = req.actor;
      if (!actor || actor.type === "none") {
        res.status(401).json({ error: "minter_unauthenticated" });
        return;
      }
      if (actor.type !== "board" || !actor.userId) {
        res.status(403).json({ error: "admin_override_principal_forbidden" });
        return;
      }

      const principals = getConfiguredPrincipals();
      if (principals.size === 0) {
        res.status(503).json({
          error: "admin_override_minter_not_configured",
          message:
            "PAPERCLIP_ADMIN_OVERRIDE_PRINCIPALS is unset. Minter is disabled until a CEO principal is configured.",
        });
        return;
      }
      if (!principals.has(actor.userId)) {
        res.status(403).json({ error: "admin_override_principal_forbidden" });
        return;
      }

      if (!process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY?.trim()) {
        res.status(503).json({
          error: "admin_override_signing_key_missing",
          message: "PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY is not configured on this host.",
        });
        return;
      }

      // AC-8-A: CEO session must be fresh (re-auth <=60s).
      const sessionId = (actor as { keyId?: string }).keyId;
      if (!sessionId) {
        res.status(401).json({
          error: "minter_reauth_required",
          message: "No session context available. Re-authenticate within 60 seconds of minting.",
        });
        return;
      }
      const [sessionRow] = await opts.db
        .select({ createdAt: authSessions.createdAt, userId: authSessions.userId })
        .from(authSessions)
        .where(eq(authSessions.id, sessionId))
        .limit(1);
      if (!sessionRow || sessionRow.userId !== actor.userId) {
        res.status(401).json({
          error: "minter_reauth_required",
          message: "Session not found or principal mismatch.",
        });
        return;
      }
      const sessionAgeSeconds = Math.floor((now() - sessionRow.createdAt.getTime()) / 1000);
      if (sessionAgeSeconds > CEO_REAUTH_WINDOW_SECONDS) {
        res.status(401).json({
          error: "minter_reauth_required",
          message: `Session is ${sessionAgeSeconds}s old. Re-authenticate within ${CEO_REAUTH_WINDOW_SECONDS} seconds before minting.`,
        });
        return;
      }

      // AC-8-B: rate limit <=5/h, <=10/d per principal.
      const decision = limiter.record(actor.userId);
      if (!decision.allowed) {
        if (decision.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        }
        res.status(429).json({
          error: "minter_rate_limit_exceeded",
          message: "Admin override mint rate limit exceeded.",
          retryAfterSeconds: decision.retryAfterSeconds,
          hourlyRemaining: decision.hourlyRemaining,
          dailyRemaining: decision.dailyRemaining,
        });
        return;
      }

      const body = req.body as z.infer<typeof mintRequestSchema>;
      const jti = randomUUID();
      const ttlSeconds = body.ttlSeconds ?? ADMIN_OVERRIDE_CONSTANTS.ttlMaxSeconds;

      const token = createAdminOverrideJwt({
        subject: actor.userId,
        issueId: body.issueId,
        oldStatus: body.oldStatus,
        newStatus: body.newStatus,
        reason: body.reason,
        jti,
        ttlSeconds,
      });
      if (!token) {
        res.status(503).json({
          error: "admin_override_signing_key_missing",
          message: "Unable to mint admin override JWT — signing key not available.",
        });
        return;
      }

      const mintedAtMs = now();
      const expiresAtMs = mintedAtMs + ttlSeconds * 1000;

      logger.warn(
        {
          event: "admin_override.mint_issued",
          principalUserId: actor.userId,
          jti,
          issueId: body.issueId,
          oldStatus: body.oldStatus,
          newStatus: body.newStatus,
          ttlSeconds,
          hourlyRemaining: decision.hourlyRemaining,
          dailyRemaining: decision.dailyRemaining,
        },
        "Admin override JWT minted",
      );

      res.status(201).json({
        token,
        jti,
        mintedAt: new Date(mintedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        ttlSeconds,
        rateLimit: {
          hourlyRemaining: decision.hourlyRemaining,
          dailyRemaining: decision.dailyRemaining,
        },
      });
    },
  );

  return router;
}
