import type { CommandHandler } from "./types.js";

function formatExpiry(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  return `${minutes} мин`;
}

export const loginCommand: CommandHandler = async (ctx, { codeStore }) => {
  const issued = codeStore.issue({
    chatId: ctx.chatId,
    tgUserId: ctx.tgUserId ?? null,
    tgUsername: ctx.tgUsername ?? null,
  });
  await ctx.reply(
    `Твой код: \`${issued.code}\`. Вставь в Profile → Telegram. Действителен ${formatExpiry(
      issued.expiresAt,
      Date.now(),
    )}.`,
  );
};
