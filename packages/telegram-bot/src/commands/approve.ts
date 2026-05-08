import type { CommandHandler } from "./types.js";

export const approveCommand: CommandHandler = async (ctx, { client }) => {
  const id = ctx.text.replace(/^\/approve(@\S+)?\s*/i, "").trim();
  if (!id) {
    await ctx.reply("Использование: /approve <approval-id>");
    return;
  }
  try {
    await client.approveApproval(id, { onBehalfOfChatId: ctx.chatId, onBehalfOfUserId: ctx.tgUserId });
    await ctx.reply(`Approval ${id} одобрен.`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "неизвестная ошибка";
    await ctx.reply(`Не удалось одобрить approval ${id}: ${reason}`);
  }
};

export const denyCommand: CommandHandler = async (ctx, { client }) => {
  const id = ctx.text.replace(/^\/deny(@\S+)?\s*/i, "").trim();
  if (!id) {
    await ctx.reply("Использование: /deny <approval-id>");
    return;
  }
  try {
    await client.rejectApproval(id, { onBehalfOfChatId: ctx.chatId, onBehalfOfUserId: ctx.tgUserId });
    await ctx.reply(`Approval ${id} отклонён.`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "неизвестная ошибка";
    await ctx.reply(`Не удалось отклонить approval ${id}: ${reason}`);
  }
};
