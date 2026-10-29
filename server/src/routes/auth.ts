import { Router } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts, authUsers } from "@paperclipai/db";
import {
  authAccountSecuritySchema,
  authSessionSchema,
  authSignInOptionsSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { unauthorized } from "../errors.js";
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

export function authRoutes(db: Db, opts: { passkeyOrigin?: string | null } = {}) {
  const router = Router();

  router.get("/sign-in-options", (_req, res) => {
    res.json(authSignInOptionsSchema.parse({
      passkeyOrigin: opts.passkeyOrigin ?? null,
    }));
  });

  router.get("/account-security", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    // Better Auth keeps the password on the "credential" account. Users provisioned
    // through handoff have none, and every two-factor change re-checks the password.
    const user = await db
      .select({ twoFactorEnabled: authUsers.twoFactorEnabled, credentialAccountId: authAccounts.id })
      .from(authUsers)
      .leftJoin(
        authAccounts,
        and(
          eq(authAccounts.userId, authUsers.id),
          eq(authAccounts.providerId, "credential"),
          isNotNull(authAccounts.password),
        ),
      )
      .where(eq(authUsers.id, req.actor.userId))
      .then((rows) => rows[0] ?? null);

    if (!user) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(authAccountSecuritySchema.parse({
      twoFactorEnabled: user.twoFactorEnabled,
      hasPassword: user.credentialAccountId !== null,
    }));
  });

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

  return router;
}
