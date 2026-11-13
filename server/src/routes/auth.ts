import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { resolveSentryDsns } from "../sentry-dsn.js";
import { resolveBrowserTracingConfig, warnOnce } from "../browser-tracing-config.js";
import { logger } from "../middleware/logger.js";
import { loadBoardBootstrap } from "../services/board-bootstrap.js";

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

const warnBrowserTracing = warnOnce((message) => logger.warn(message));

export function authRoutes(db: Db) {
  const router = Router();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const bootstrap = (req.actor.source === "session" || req.actor.source === "cloud_tenant")
      && Array.isArray(req.actor.companyIds)
      ? loadBoardBootstrap(db, { userId: req.actor.userId, companyIds: req.actor.companyIds }).catch((err) => {
        logger.warn({ err }, "failed to load optional board bootstrap");
        return undefined;
      })
      : Promise.resolve(undefined);
    const [user, boardBootstrap] = await Promise.all([loadCurrentUserProfile(db, req.actor.userId), bootstrap]);
    res.setHeader("Cache-Control", "private, no-store");
    const session = authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
      // The browser reads this value to open its own Sentry gate — see
      // `ui/src/lib/sentry.ts`. `req.actor.type` already gates this whole
      // handler, so no second authorization check runs here. This field
      // carries the front-end DSN only; it never carries the backend DSN.
      sentryDsn: resolveSentryDsns().frontend,
      // Match the server SDK's runtime environment, including in reused images.
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT || null,
      // Hosted Paperclip Cloud only; null everywhere else. The ingest key is
      // ingest-only by construction — see `server/src/browser-tracing-config.ts`.
      browserTracing: resolveBrowserTracingConfig(process.env, warnBrowserTracing),
    });
    res.json({ ...session, ...(boardBootstrap ? { boardBootstrap } : {}) });
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  });

  return router;
}
