import { createHmac, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions, authUsers } from "@paperclipai/db";
import { deriveAuthCookiePrefix } from "../auth/better-auth.js";
import { verifyPortalJwt, type PortalJwtClaims } from "../auth/portal-jwt.js";
import { logger } from "../middleware/logger.js";

const REQUIRED_APP_ACCESS = "CORTEX";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function sessionCookieName(): string {
  return `${deriveAuthCookiePrefix()}.session_token`;
}

function betterAuthSecret(): string | null {
  const secret = (process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "").trim();
  return secret.length > 0 ? secret : null;
}

function signCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return encodeURIComponent(`${value}.${signature}`);
}

export function isSafeRedirectTarget(target: string | undefined | null): target is string {
  if (typeof target !== "string" || target.length === 0) return false;
  if (!target.startsWith("/")) return false;
  if (target.startsWith("//")) return false;
  if (target.includes("\\")) return false;
  return true;
}

function resolveRedirectTarget(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  return isSafeRedirectTarget(raw) ? raw : "/";
}

function setSessionCookie(res: Response, token: string, secret: string, isHttps: boolean): void {
  const signed = signCookieValue(token, secret);
  const parts: string[] = [
    `${sessionCookieName()}=${signed}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`,
  ];
  if (isHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function detectHttps(req: Request): boolean {
  if (req.secure) return true;
  const xfp = req.header("x-forwarded-proto");
  if (xfp && xfp.split(",")[0]?.trim().toLowerCase() === "https") return true;
  return false;
}

async function findOrCreateCortexUser(
  db: Db,
  claims: PortalJwtClaims,
  now: Date,
): Promise<{ id: string; created: boolean }> {
  const normalizedEmail = claims.email.toLowerCase();
  const existing = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, normalizedEmail))
    .then((rows: { id: string }[]) => rows[0] ?? null);
  if (existing) return { id: existing.id, created: false };

  const id = randomBytes(16).toString("hex");
  const name = claims.name && claims.name.trim().length > 0 ? claims.name.trim() : normalizedEmail;
  await db.insert(authUsers).values({
    id,
    name,
    email: normalizedEmail,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  return { id, created: true };
}

async function insertSession(
  db: Db,
  userId: string,
  now: Date,
  req: Request,
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("hex");
  const id = randomBytes(16).toString("hex");
  await db.insert(authSessions).values({
    id,
    token,
    userId,
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
  });
  return { token };
}

export function portalCallbackRoutes(db: Db) {
  const router = Router();

  router.get("/cortex/auth/callback", async (req, res) => {
    const tokenParam = req.query.token;
    if (typeof tokenParam !== "string" || tokenParam.length === 0) {
      res.status(400).json({ error: "missing_token" });
      return;
    }

    const result = verifyPortalJwt(tokenParam);
    if (!result.ok) {
      logger.warn({ reason: result.reason }, "Portal JWT verification failed");
      const status = result.reason === "secret_missing" ? 503 : 403;
      res.status(status).json({ error: result.reason });
      return;
    }

    const claims = result.claims;
    if (!claims.app_access.includes(REQUIRED_APP_ACCESS)) {
      logger.warn(
        { sub: claims.sub, app_access: claims.app_access },
        "Portal JWT entitlement denied: CORTEX not in app_access",
      );
      res.status(403).json({ error: "entitlement_denied" });
      return;
    }

    const cookieSecret = betterAuthSecret();
    if (!cookieSecret) {
      logger.error("BETTER_AUTH_SECRET not configured; cannot establish Cortex session");
      res.status(503).json({ error: "auth_not_configured" });
      return;
    }

    const now = new Date();
    const { id: userId, created } = await findOrCreateCortexUser(db, claims, now);
    const { token } = await insertSession(db, userId, now, req);

    setSessionCookie(res, token, cookieSecret, detectHttps(req));

    logger.info(
      { sub: claims.sub, userId, created, app_access: claims.app_access },
      "Portal JWT exchanged for Cortex session",
    );

    const redirectTo = resolveRedirectTarget(req.query.redirect_to);
    res.redirect(302, redirectTo);
  });

  return router;
}
