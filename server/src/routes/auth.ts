import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";

function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.PAPERCLIP_ADMIN_EMAILS ?? process.env.PAPERCLIP_ADMIN_EMAIL ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function signUpIsDisabled(): boolean {
  return process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true";
}

async function ensureConfiguredAdminAccess(
  db: Db,
  user: { id: string; email: string | null; emailVerified: boolean },
) {
  const email = user.email?.trim().toLowerCase();
  if (!email || !configuredAdminEmails().has(email)) return;
  if (!user.emailVerified && !signUpIsDisabled()) return;

  const now = new Date();
  await db
    .insert(instanceUserRoles)
    .values({
      userId: user.id,
      role: "instance_admin",
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [instanceUserRoles.userId, instanceUserRoles.role],
    });

  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: user.id,
        status: "active",
        membershipRole: "owner",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
        set: {
          status: "active",
          membershipRole: "owner",
          updatedAt: now,
        },
      });
  }
}

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
      emailVerified: authUsers.emailVerified,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  await ensureConfiguredAdminAccess(db, user);

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
      emailVerified: authUsers.emailVerified,
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
