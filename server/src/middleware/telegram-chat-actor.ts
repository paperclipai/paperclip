import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { boardAuthService } from "../services/board-auth.js";
import { logger } from "./logger.js";

/**
 * Resolve `X-Telegram-Chat-Id` header into the linked auth_users user and
 * upgrade `req.actor` to that user (board-typed). Runs AFTER actorMiddleware,
 * so it only fires when a recognised agent token already authenticated the
 * request — i.e., the bot acting on-behalf-of a linked board user.
 *
 * Without this, on-behalf-of issue/comment/approval actions stay attributed
 * to the bot's agent account (`createdByUserId = null`), which hides them
 * from the user's own inbox views (`touchedByUserId=me`).
 *
 * Closes the THE-343 contract gap explicitly flagged by Bot Engineer:
 * "Server-side resolver-middleware для этого header'а — отдельный тикет".
 */
export function telegramChatActorMiddleware(db: Db): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    const headerVal = req.header("x-telegram-chat-id");
    if (!headerVal) return next();
    if (req.actor?.type !== "agent") return next();

    const chatId = headerVal.trim();
    if (!chatId) return next();

    try {
      const userRow = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.telegramChatId, chatId))
        .then((rows) => rows[0] ?? null);

      if (!userRow) {
        logger.debug({ chatId }, "X-Telegram-Chat-Id header present but no linked user");
        return next();
      }

      const access = await boardAuth.resolveBoardAccess(userRow.id);
      const previous = req.actor;
      req.actor = {
        type: "board",
        userId: userRow.id,
        userName: access.user?.name ?? userRow.name ?? null,
        userEmail: access.user?.email ?? userRow.email ?? null,
        companyIds: access.companyIds,
        memberships: access.memberships,
        isInstanceAdmin: access.isInstanceAdmin,
        runId: previous.runId,
        source: "telegram_chat_id",
      };
    } catch (err) {
      logger.warn({ err, chatId }, "Failed to upgrade actor via X-Telegram-Chat-Id");
    }
    next();
  };
}
