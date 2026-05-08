import type { CommandHandler } from "./types.js";

/**
 * Handler for plain (non-command) messages that are replies to a previous bot
 * notification. Looks up the issue via the ReplyStore and posts the message
 * body as a comment on that issue.
 */
export const replyHandler: CommandHandler = async (ctx, { client, replyStore }) => {
  if (!ctx.replyToMessageId) return;
  const target = replyStore.lookup(ctx.chatId, ctx.replyToMessageId);
  if (!target) return;
  const body = ctx.text.trim();
  if (!body) return;
  try {
    await client.postIssueComment(target.issueId, body, { onBehalfOfChatId: ctx.chatId });
    await ctx.reply("Комментарий добавлен.");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "неизвестная ошибка";
    await ctx.reply(`Не удалось отправить комментарий: ${reason}`);
  }
};
