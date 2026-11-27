import { Router } from "express";
import { z } from "zod";
import { and, eq, gt, ne } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import { authAccounts, authSessions } from "@paperclipai/db";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
});

export function userRoutes(db: Db) {
  const router = Router();

  router.post(
    "/users/me/change-password",
    validate(changePasswordSchema),
    async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId || req.actor.source === "local_implicit") {
        throw unauthorized("Authentication required");
      }

      const userId = req.actor.userId;
      const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

      const account = await db
        .select({ id: authAccounts.id, password: authAccounts.password })
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")))
        .then((rows) => rows[0] ?? null);

      if (!account || !account.password) {
        throw badRequest("No password-based account found for this user");
      }

      const valid = await verifyPassword({ hash: account.password, password: currentPassword });
      if (!valid) {
        throw badRequest("Current password is incorrect");
      }

      const newHash = await hashPassword(newPassword);

      await db
        .update(authAccounts)
        .set({ password: newHash, updatedAt: new Date() })
        .where(eq(authAccounts.id, account.id));

      // Invalidate all sessions except the current one
      const currentSessionId = req.actor.sessionId;
      if (currentSessionId) {
        await db
          .delete(authSessions)
          .where(and(eq(authSessions.userId, userId), ne(authSessions.id, currentSessionId)));
      } else {
        await db.delete(authSessions).where(eq(authSessions.userId, userId));
      }

      res.json({ message: "Password changed" });
    },
  );

  router.get("/users/me/sessions", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId || req.actor.source === "local_implicit") {
      throw unauthorized("Authentication required");
    }

    const userId = req.actor.userId;
    const currentSessionId = req.actor.sessionId;

    const sessions = await db
      .select({
        id: authSessions.id,
        ipAddress: authSessions.ipAddress,
        userAgent: authSessions.userAgent,
        createdAt: authSessions.createdAt,
        lastActiveAt: authSessions.updatedAt,
      })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())));

    res.json({
      data: sessions.map((s) => ({ ...s, isCurrent: s.id === currentSessionId })),
    });
  });

  router.delete("/users/me/sessions/:id", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId || req.actor.source === "local_implicit") {
      throw unauthorized("Authentication required");
    }

    const userId = req.actor.userId;
    const sessionId = req.params.id;

    const session = await db
      .select({ id: authSessions.id, userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.id, sessionId))
      .then((rows) => rows[0] ?? null);

    if (!session) {
      throw notFound("Session not found");
    }

    if (session.userId !== userId) {
      throw forbidden("Session does not belong to this user");
    }

    await db.delete(authSessions).where(eq(authSessions.id, sessionId));

    res.status(204).end();
  });

  return router;
}
