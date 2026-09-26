import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserPreferencesSchema,
  updateCurrentUserPreferencesSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { hasCompanyAccess } from "./authz.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { forbidden, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { resolveSentryDsns } from "../sentry-dsn.js";

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

export function authRoutes(db: Db) {
  const router = Router();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    res.json(authSessionSchema.parse({
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
    }));
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

  router.get("/preferences", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    if (req.query.expectedUserId !== req.actor.userId) throw unauthorized("Account changed. Refresh and try again.");
    const [user] = await db.select({ keyboardShortcuts: authUsers.keyboardShortcuts })
      .from(authUsers).where(eq(authUsers.id, req.actor.userId));
    if (!user) throw unauthorized("Signed-in user not found");
    res.json(currentUserPreferencesSchema.parse(user));
  });

  router.patch("/preferences", validate(updateCurrentUserPreferencesSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const { companyId, keyboardShortcuts, expectedUserId } = updateCurrentUserPreferencesSchema.parse(req.body);
    const userId = req.actor.userId;
    if (expectedUserId !== userId) throw unauthorized("Account changed. Refresh and try again.");
    // This is a personal write; company membership supplies audit context only.
    if (!hasCompanyAccess(req, companyId)) throw forbidden("User does not have access to this company");
    const publications: ActivityPublication[] = [];
    const user = await db.transaction(async (tx) => {
      const [updated] = await tx.update(authUsers)
        .set({ keyboardShortcuts, updatedAt: new Date() })
        .where(eq(authUsers.id, userId))
        .returning({ keyboardShortcuts: authUsers.keyboardShortcuts });
      if (!updated) throw unauthorized("Signed-in user not found");
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "user.preferences_updated",
        entityType: "user",
        entityId: userId,
        details: { keyboardShortcuts },
      }, publications);
      return updated;
    });
    for (const publication of publications) {
      try {
        publishActivity(publication);
      } catch (err) {
        // The preference and audit row are committed; notification failure must
        // not tell the caller that its durable save failed.
        logger.warn({ err, companyId, userId }, "Could not publish user preference activity");
      }
    }
    res.json(currentUserPreferencesSchema.parse(user));
  });

  return router;
}
