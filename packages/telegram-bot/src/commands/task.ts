import { PaperclipApiError } from "../api/paperclip-client.js";
import type { CommandHandler } from "./types.js";

const MAX_TITLE_LEN = 80;

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? text.trim();
  if (firstLine.length <= MAX_TITLE_LEN) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LEN - 1)}…`;
}

export function makeTaskCommand(opts: { ceoAgentId: string }): CommandHandler {
  return async (ctx, { client }) => {
    const text = ctx.text.replace(/^\/task(@\S+)?\s*/i, "").trim();
    if (!text) {
      await ctx.reply("Использование: /task <текст задачи>");
      return;
    }
    try {
      const issue = await client.createIssue(
        {
          title: deriveTitle(text),
          description: text,
          assigneeAgentId: opts.ceoAgentId,
        },
        { onBehalfOfChatId: ctx.chatId },
      );
      const ident = issue.identifier ?? issue.id;
      await ctx.reply(`Создал задачу ${ident}: ${issue.title ?? deriveTitle(text)}`);
    } catch (err) {
      if (err instanceof PaperclipApiError && err.status === 401) {
        await ctx.reply(
          "Не получилось создать задачу: Telegram-аккаунт не привязан. Запусти /login и вставь код в Profile → Telegram.",
        );
        return;
      }
      const reason = err instanceof Error ? err.message : "неизвестная ошибка";
      await ctx.reply(`Не получилось создать задачу: ${reason}`);
    }
  };
}
