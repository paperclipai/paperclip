import { Router, type Request, type Response } from "express";
import * as jose from "jose";
import type { Db } from "@paperclipai/db";
import { authUsers, authAccounts, authSessions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

/**
 * POST /api/auth/bridge
 *
 * Accepts a Supabase access_token JWT, verifies it cryptographically,
 * then finds-or-creates a Better Auth user and issues a session cookie.
 */

// Simple in-memory rate limiter (per IP, 10 req/min)
const rateLimitWindow = 60_000;
const rateLimitMax = 10;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + rateLimitWindow });
    return false;
  }
  entry.count++;
  return entry.count > rateLimitMax;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now >= entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60_000).unref();

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function supabaseBridgeRoute(db: Db): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

    if (isRateLimited(ip)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const jwtSecret = process.env.EMISSO_OS_SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
      logger.error("EMISSO_OS_SUPABASE_JWT_SECRET is not configured");
      res.status(500).json({ error: "Bridge not configured" });
      return;
    }

    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "Missing token" });
      return;
    }

    // Verify JWT cryptographically
    let claims: jose.JWTPayload;
    try {
      const secret = new TextEncoder().encode(jwtSecret);
      const result = await jose.jwtVerify(token, secret, {
        algorithms: ["HS256"],
      });
      claims = result.payload;
    } catch (err) {
      logger.warn({ err }, "Supabase bridge: invalid JWT");
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const sub = claims.sub;
    const email = (claims as Record<string, unknown>).email as string | undefined;
    const userMetadata = (claims as Record<string, unknown>).user_metadata as
      | { full_name?: string }
      | undefined;
    const fullName = userMetadata?.full_name ?? null;

    if (!sub || !email) {
      res.status(400).json({ error: "Token missing required claims (sub, email)" });
      return;
    }

    try {
      // Find existing user by email
      const [existingUser] = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, email))
        .limit(1);

      let userId: string;

      if (existingUser) {
        userId = existingUser.id;
        // Update name if it changed
        if (fullName && fullName !== existingUser.name) {
          await db
            .update(authUsers)
            .set({ name: fullName, updatedAt: new Date() })
            .where(eq(authUsers.id, userId));
        }
      } else {
        // Create new user
        const id = crypto.randomUUID();
        await db.insert(authUsers).values({
          id,
          email,
          name: fullName ?? email.split("@")[0],
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Create an account link for the supabase provider
        await db.insert(authAccounts).values({
          id: crypto.randomUUID(),
          userId: id,
          accountId: sub,
          providerId: "supabase-bridge",
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        userId = id;
      }

      // Create a Better Auth-compatible session directly in the DB
      const sessionId = crypto.randomUUID();
      const sessionToken = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

      await db.insert(authSessions).values({
        id: sessionId,
        token: sessionToken,
        userId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        ipAddress: ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      logger.info({ userId, supabaseUserId: sub, email }, "Supabase bridge: session created");

      // Set session cookie (matches Better Auth's cookie format)
      res.cookie("better-auth.session_token", sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        expires: expiresAt,
        path: "/",
      });

      res.json({ ok: true, userId });
    } catch (err) {
      logger.error({ err }, "Supabase bridge: failed to create session");
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
