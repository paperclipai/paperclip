/**
 * Telegram slash commands for the Paperclip bridge.
 *
 * Commands that query or mutate Paperclip state via the REST API.
 * Ported from the dead v2/telegram-commands.ts, but reimplemented
 * against Paperclip API instead of v2's SQLite.
 *
 * Commands:
 *   /status   — active issue counts for the current workspace
 *   /tasks    — list open issues (todo + in_progress + in_review)
 *   /approve  — mark an issue as done (approve)
 *   /reject   — send a rework comment and reopen
 *   /cancel   — set issue status to cancelled
 *   /agents   — list agents for the current workspace
 *   /crons    — list routines for the current workspace
 *   /help     — list available commands
 */

import type { Bot } from "grammy";
import type { PaperclipBridgeClient } from "./paperclip-client.js";
import type { ChatToCompanyMapping } from "./types.js";

export type CommandDeps = {
  client: PaperclipBridgeClient;
  findMapping: (chatId: string, threadId?: number) => ChatToCompanyMapping | null;
  verbose: boolean;
};

const ALLOWED_USER_IDS: Set<number> = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").filter(Boolean).map(Number),
);

function allowed(userId: number): boolean {
  // If no allowlist configured, allow everyone (local dev mode)
  if (ALLOWED_USER_IDS.size === 0) return true;
  return ALLOWED_USER_IDS.has(userId);
}

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const { client, findMapping, verbose } = deps;

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Paperclip bridge active. Send a message to create a task.\n" +
      "Type /help for available commands.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "/status — Active issue counts\n" +
      "/tasks — List open issues\n" +
      "/approve <id> — Approve an issue (mark done)\n" +
      "/reject <id> [reason] — Reject/rework an issue\n" +
      "/cancel <id> — Cancel an issue\n" +
      "/agents — List agents in this workspace\n" +
      "/crons — List scheduled routines",
    );
  });

  bot.command("status", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const mapping = findMapping(String(ctx.chat?.id ?? ""), (ctx.message as any)?.message_thread_id);
    if (!mapping) {
      await ctx.reply("No workspace mapped to this chat.");
      return;
    }
    try {
      const issues = await client.listIssues(mapping.companyId);
      const counts: Record<string, number> = {};
      for (const i of issues) {
        counts[i.status] = (counts[i.status] ?? 0) + 1;
      }
      const lines = [
        `*${mapping.workspace}* workspace status:`,
        `  todo: ${counts["todo"] ?? 0}`,
        `  in_progress: ${counts["in_progress"] ?? 0}`,
        `  in_review: ${counts["in_review"] ?? 0}`,
        `  done: ${counts["done"] ?? 0}`,
        `  blocked: ${counts["blocked"] ?? 0}`,
        `  cancelled: ${counts["cancelled"] ?? 0}`,
        `  backlog: ${counts["backlog"] ?? 0}`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:status]", err?.message ?? err);
      await ctx.reply("Failed to fetch status.");
    }
  });

  bot.command("tasks", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const mapping = findMapping(String(ctx.chat?.id ?? ""), (ctx.message as any)?.message_thread_id);
    if (!mapping) {
      await ctx.reply("No workspace mapped to this chat.");
      return;
    }
    try {
      const issues = await client.listIssues(mapping.companyId);
      const open = issues.filter(
        (i) => i.status === "todo" || i.status === "in_progress" || i.status === "in_review",
      );
      if (open.length === 0) {
        await ctx.reply("No open issues.");
        return;
      }
      const lines = open.slice(0, 15).map((i) => {
        const agent = i.assigneeAgentId ? ` → ${i.assigneeAgentId.slice(0, 8)}…` : "";
        return `\`${i.identifier}\` ${i.status}${agent} — ${i.title}`;
      });
      let text = `*Open issues (${open.length}):*\n` + lines.join("\n");
      if (open.length > 15) text += `\n… and ${open.length - 15} more`;
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:tasks]", err?.message ?? err);
      await ctx.reply("Failed to fetch tasks.");
    }
  });

  bot.command("approve", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const identifier = args[0];
    if (!identifier) {
      await ctx.reply("Usage: /approve <issue-id-or-identifier>");
      return;
    }
    try {
      const issueId = await client.resolveIssueId(identifier);
      if (!issueId) {
        await ctx.reply(`Issue \`${identifier}\` not found.`, { parse_mode: "Markdown" });
        return;
      }
      await client.updateIssue(issueId, { status: "done" });
      await ctx.reply(`✅ \`${identifier}\` approved.`, { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:approve]", err?.message ?? err);
      await ctx.reply(`Failed to approve: ${err?.message ?? err}`);
    }
  });

  bot.command("reject", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);
    const identifier = parts[1];
    if (!identifier) {
      await ctx.reply("Usage: /reject <issue-id-or-identifier> [reason]");
      return;
    }
    const reason = parts.slice(2).join(" ") || "Rejected via Telegram";
    try {
      const issueId = await client.resolveIssueId(identifier);
      if (!issueId) {
        await ctx.reply(`Issue \`${identifier}\` not found.`, { parse_mode: "Markdown" });
        return;
      }
      await client.updateIssue(issueId, {
        status: "todo",
        comment: `❌ Rejected: ${reason}`,
        reopen: true,
      });
      await ctx.reply(`🔄 \`${identifier}\` rejected — sent back for rework.`, { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:reject]", err?.message ?? err);
      await ctx.reply(`Failed to reject: ${err?.message ?? err}`);
    }
  });

  bot.command("cancel", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const identifier = args[0];
    if (!identifier) {
      await ctx.reply("Usage: /cancel <issue-id-or-identifier>");
      return;
    }
    try {
      const issueId = await client.resolveIssueId(identifier);
      if (!issueId) {
        await ctx.reply(`Issue \`${identifier}\` not found.`, { parse_mode: "Markdown" });
        return;
      }
      await client.updateIssue(issueId, { status: "cancelled" });
      await ctx.reply(`🗑 \`${identifier}\` cancelled.`, { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:cancel]", err?.message ?? err);
      await ctx.reply(`Failed to cancel: ${err?.message ?? err}`);
    }
  });

  bot.command("agents", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const mapping = findMapping(String(ctx.chat?.id ?? ""), (ctx.message as any)?.message_thread_id);
    if (!mapping) {
      await ctx.reply("No workspace mapped to this chat.");
      return;
    }
    try {
      const agents = await client.listAgents(mapping.companyId);
      if (agents.length === 0) {
        await ctx.reply("No agents in this workspace.");
        return;
      }
      const lines = agents.map((a) => `\`${a.name}\` (${a.id.slice(0, 8)}…) ${a.adapterType ?? ""}`);
      await ctx.reply("*Agents:*\n" + lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:agents]", err?.message ?? err);
      await ctx.reply("Failed to fetch agents.");
    }
  });

  bot.command("crons", async (ctx) => {
    if (!allowed(ctx.from?.id ?? 0)) return;
    const mapping = findMapping(String(ctx.chat?.id ?? ""), (ctx.message as any)?.message_thread_id);
    if (!mapping) {
      await ctx.reply("No workspace mapped to this chat.");
      return;
    }
    try {
      const routines = await client.listRoutines(mapping.companyId);
      if (routines.length === 0) {
        await ctx.reply("No routines in this workspace.");
        return;
      }
      const lines = routines.slice(0, 20).map((r) => {
        const trigger = r.triggers?.[0];
        const cron = trigger?.cronExpression ?? "manual";
        return `\`${r.title}\` ${cron}`;
      });
      let text = `*Routines (${routines.length}):*\n` + lines.join("\n");
      if (routines.length > 20) text += `\n… and ${routines.length - 20} more`;
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (err: any) {
      verbose && console.error("[cmd:crons]", err?.message ?? err);
      await ctx.reply("Failed to fetch routines.");
    }
  });
}
