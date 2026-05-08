import type { CommandHandler } from "./types.js";

function shorten(s: string, max = 240): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export const issueCommand: CommandHandler = async (ctx, { client }) => {
  const arg = ctx.text.replace(/^\/issue(@\S+)?\s*/i, "").trim();
  if (!arg) {
    await ctx.reply("Использование: /issue <ID>  (например: THE-341)");
    return;
  }
  try {
    const issue = await client.findIssue(arg, { onBehalfOfChatId: ctx.chatId, onBehalfOfUserId: ctx.tgUserId });
    if (!issue) {
      await ctx.reply(`Issue ${arg} не найден.`);
      return;
    }
    const ident = issue.identifier ?? issue.id;
    const lines = [
      `${ident}: ${issue.title ?? "(без названия)"}`,
      `status: ${issue.status ?? "—"}`,
      `assignee: ${issue.assigneeAgentId ?? issue.assigneeUserId ?? "—"}`,
    ];
    const comment = await client
      .getLatestIssueComment(issue.id, { onBehalfOfChatId: ctx.chatId, onBehalfOfUserId: ctx.tgUserId })
      .catch(() => null);
    if (comment?.body) {
      lines.push(`последний комментарий: ${shorten(comment.body)}`);
    }
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : "неизвестная ошибка";
    await ctx.reply(`Не удалось получить issue ${arg}: ${reason}`);
  }
};
