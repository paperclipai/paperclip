import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { eq, or } from "drizzle-orm";
import type { RequestHandler } from "express";
import { boardAuthService } from "../services/board-auth.js";
import { logger } from "./logger.js";

/**
 * Resolve Telegram identity headers into the linked auth_users user and
 * upgrade `req.actor` to that user (board-typed). Runs AFTER actorMiddleware,
 * so it only fires when a recognised agent token already authenticated the
 * request — i.e., the bot acting on-behalf-of a linked board user.
 *
 * Two headers supported:
 *  - `X-Telegram-User-Id` (preferred — works in groups too, where chat id != user id)
 *  - `X-Telegram-Chat-Id` (legacy — works in private chats where chat id == user id)
 *
 * If both present we try user-id first (more specific). DB column lookup is
 * done with OR across telegram_user_id / telegram_chat_id so previously-linked
 * accounts continue to work.
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
    const userIdHeader = req.header("x-telegram-user-id")?.trim();
    const chatIdHeader = req.header("x-telegram-chat-id")?.trim();
    if (!userIdHeader && !chatIdHeader) return next();
    if (req.actor?.type !== "agent") return next();

    try {
      // Build OR predicate: match if either column equals its corresponding header.
      const conditions = [];
      if (userIdHeader) conditions.push(eq(authUsers.telegramUserId, userIdHeader));
      if (chatIdHeader) conditions.push(eq(authUsers.telegramChatId, chatIdHeader));
      const predicate = conditions.length === 1 ? conditions[0] : or(...conditions);

      const userRow = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(predicate)
        .then((rows) => rows[0] ?? null);

      if (!userRow) {
        logger.debug(
          { userIdHeader, chatIdHeader },
          "Telegram identity headers present but no linked user",
        );
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
      logger.warn(
        { err, userIdHeader, chatIdHeader },
        "Failed to upgrade actor via Telegram identity headers",
      );
    }
    next();
  };
}
