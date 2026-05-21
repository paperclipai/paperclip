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
import {
  createUnauthenticatedLoginSession,
  isUnauthenticatedLoginAvailable,
  resolveUnauthenticatedLoginCompanyId,
  serializeUnauthenticatedLoginCookie,
} from "../services/unauthenticated-login-session.js";

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

  router.get("/unauthenticated-login/availability", async (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
    const resolvedCompanyId = companyId || await resolveUnauthenticatedLoginCompanyId(db);
    const available = resolvedCompanyId ? await isUnauthenticatedLoginAvailable(db, resolvedCompanyId) : false;

    res.json({ available, companyId: available ? resolvedCompanyId : null });
  });

  router.post("/unauthenticated-login/session", async (req, res) => {
    const companyId = typeof req.body?.companyId === "string" ? req.body.companyId.trim() : "";
    const token = await createUnauthenticatedLoginSession(db, companyId);
    if (!token) {
      res.status(403).json({ error: "Unauthenticated development entry is disabled." });
      return;
    }

    res.setHeader("Set-Cookie", serializeUnauthenticatedLoginCookie(token));
    res.json({ ok: true });
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
