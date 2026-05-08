import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  linkTelegramAccountSchema,
  telegramLinkStatusSchema,
  type TelegramLinkStatus,
} from "@paperclipai/shared";
import { badRequest, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";

export type ResolveTelegramCodeResult = {
  tgChatId: string;
  tgUserId?: string | null;
  tgUsername?: string | null;
};

export type ResolveTelegramCodeFn = (code: string) => Promise<ResolveTelegramCodeResult | null>;

function defaultResolveTelegramCode(): ResolveTelegramCodeFn {
  return async (code: string) => {
    const baseUrl = process.env.TELEGRAM_BOT_INTERNAL_URL?.trim();
    const secret = process.env.TELEGRAM_BOT_INTERNAL_SECRET?.trim();
    if (!baseUrl || !secret) {
      throw new Error(
        "Telegram bot integration is not configured. Set TELEGRAM_BOT_INTERNAL_URL and TELEGRAM_BOT_INTERNAL_SECRET.",
      );
    }
    const url = new URL("/internal/resolve-code", baseUrl);
    url.searchParams.set("code", code);
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Internal-Secret": secret, Accept: "application/json" },
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      throw new Error(`Telegram bot returned ${res.status}`);
    }
    const payload = (await res.json().catch(() => null)) as
      | { tgChatId?: unknown; tgUserId?: unknown; tgUsername?: unknown }
      | null;
    const tgChatId =
      typeof payload?.tgChatId === "string" || typeof payload?.tgChatId === "number"
        ? String(payload.tgChatId)
        : null;
    if (!tgChatId) return null;
    return {
      tgChatId,
      tgUserId:
        typeof payload?.tgUserId === "string" || typeof payload?.tgUserId === "number"
          ? String(payload.tgUserId)
          : null,
      tgUsername: typeof payload?.tgUsername === "string" ? payload.tgUsername : null,
    };
  };
}

async function loadLinkStatus(db: Db, userId: string): Promise<TelegramLinkStatus> {
  const row = await db
    .select({
      telegramChatId: authUsers.telegramChatId,
      telegramUsername: authUsers.telegramUsername,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    throw unauthorized("Signed-in user not found");
  }

  return telegramLinkStatusSchema.parse({
    linked: row.telegramChatId !== null && row.telegramChatId !== undefined,
    telegramUsername: row.telegramUsername ?? null,
  });
}

export type TelegramLinkRoutesOptions = {
  resolveCode?: ResolveTelegramCodeFn;
};

export function telegramLinkRoutes(db: Db, opts: TelegramLinkRoutesOptions = {}) {
  const router = Router();
  const resolveCode = opts.resolveCode ?? defaultResolveTelegramCode();

  router.get("/users/me/telegram-link", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    res.json(await loadLinkStatus(db, req.actor.userId));
  });

  router.post(
    "/users/me/telegram-link",
    validate(linkTelegramAccountSchema),
    async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Board authentication required");
      }
      const { code } = linkTelegramAccountSchema.parse(req.body);

      const resolved = await resolveCode(code);
      if (!resolved) {
        throw badRequest("Code is invalid or has expired. Ask the bot for a new one.");
      }

      const now = new Date();
      await db
        .update(authUsers)
        .set({
          telegramChatId: resolved.tgChatId,
          telegramUserId: resolved.tgUserId ?? null,
          telegramUsername: resolved.tgUsername ?? null,
          updatedAt: now,
        })
        .where(eq(authUsers.id, req.actor.userId));

      res.json(await loadLinkStatus(db, req.actor.userId));
    },
  );

  router.delete("/users/me/telegram-link", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const now = new Date();
    await db
      .update(authUsers)
      .set({
        telegramChatId: null,
        telegramUserId: null,
        telegramUsername: null,
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId));

    res.json(await loadLinkStatus(db, req.actor.userId));
  });

  return router;
}
