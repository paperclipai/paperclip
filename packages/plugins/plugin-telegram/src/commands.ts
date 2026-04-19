import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { handleAcpCommand } from "./acp-bridge.js";

type BotCommand = { command: string; description: string };

export const BOT_COMMANDS: BotCommand[] = [
  { command: "status", description: "Company health: active agents, open issues" },
  { command: "issues", description: "List open issues (optionally by project)" },
  { command: "agents", description: "List agents with current status" },
  { command: "approve", description: "Approve a pending request by ID" },
  { command: "help", description: "Show available commands" },
  { command: "acp", description: "Manage agent sessions (spawn, status, cancel, close)" },
  { command: "commands", description: "Manage custom workflow commands (list, import, run, delete)" },
];

export async function handleCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  command: string,
  args: string,
  messageThreadId?: number,
  baseUrl?: string,
): Promise<void> {
  await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);

  switch (command) {
    case "status":
      await handleStatus(ctx, token, chatId, messageThreadId);
      break;
    case "issues":
      await handleIssues(ctx, token, chatId, args, messageThreadId);
      break;
    case "agents":
      await handleAgents(ctx, token, chatId, messageThreadId);
      break;
    case "approve":
      await handleApprove(ctx, token, chatId, args, messageThreadId, baseUrl);
      break;
    case "help":
      await handleHelp(ctx, token, chatId, messageThreadId);
      break;
    case "connect":
      await handleConnect(ctx, token, chatId, args, messageThreadId);
      break;
    case "connect-topic":
      await handleConnectTopic(ctx, token, chatId, args, messageThreadId);
      break;
    case "acp":
      await handleAcpCommand(ctx, token, chatId, args, messageThreadId);
      break;
    default:
      await sendMessage(ctx, token, chatId, `Unknown command: /${command}. Try /help`, {
        messageThreadId,
      });
  }
}

async function handleStatus(ctx: PluginContext, token: string, chatId: string, messageThreadId?: number) {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });
    const activeAgents = agents.filter((a) => a.status === "active");
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const doneIssues = issues.filter((i) => i.status === "done");

    const lines = [
      escapeMarkdownV2("\u{1f4ca}") + " *Paperclip Status*",
      "",
      `${escapeMarkdownV2("\u{1f916}")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
      `${escapeMarkdownV2("\u{1f4cb}")} Recent issues: *${escapeMarkdownV2(String(issues.length))}* \\(${escapeMarkdownV2(String(doneIssues.length))} done\\)`,
    ];

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    await sendMessage(
      ctx,
      token,
      chatId,
      escapeMarkdownV2("\u{1f4ca}") +
        " *Paperclip Status*\n\n" +
        escapeMarkdownV2("Could not fetch status. Make sure this chat is linked to a company with /connect."),
      {
        parseMode: "MarkdownV2",
        messageThreadId,
      },
    );
  }
}

async function handleIssues(
  ctx: PluginContext,
  token: string,
  chatId: string,
  projectFilter: string,
  messageThreadId?: number,
) {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const filtered = projectFilter
      ? issues.filter((i) => {
          const projName = i.project?.name ?? "";
          return projName.toLowerCase().includes(projectFilter.toLowerCase());
        })
      : issues;

    if (filtered.length === 0) {
      const filter = projectFilter ? ` for project "${projectFilter}"` : "";
      await sendMessage(ctx, token, chatId, `No issues found${filter}.`, { messageThreadId });
      return;
    }

    const statusEmoji: Record<string, string> = {
      done: "\u2705",
      todo: "\u{1f4cb}",
      in_progress: "\u{1f504}",
      backlog: "\u{1f4e5}",
    };
    const lines = [escapeMarkdownV2("\u{1f4cb}") + " *Open Issues*", ""];
    for (const issue of filtered) {
      const emoji = statusEmoji[issue.status] ?? "\u{1f4cb}";
      const id = issue.identifier ?? issue.id;
      lines.push(`${escapeMarkdownV2(emoji)} ${escapeMarkdownV2(id)} \\- ${escapeMarkdownV2(issue.title)}`);
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    const filter = projectFilter ? ` for project "${projectFilter}"` : "";
    await sendMessage(
      ctx,
      token,
      chatId,
      `Could not fetch issues${filter}. Make sure this chat is linked with /connect.`,
      { messageThreadId },
    );
  }
}

async function handleAgents(ctx: PluginContext, token: string, chatId: string, messageThreadId?: number) {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });

    if (agents.length === 0) {
      await sendMessage(ctx, token, chatId, "No agents found.", { messageThreadId });
      return;
    }

    const statusEmoji: Record<string, string> = {
      active: "\u{1f7e2}",
      error: "\u{1f534}",
      paused: "\u{1f7e1}",
      idle: "\u26aa",
      running: "\u{1f535}",
    };
    const lines = [escapeMarkdownV2("\u{1f916}") + " *Agents*", ""];
    for (const agent of agents) {
      const emoji = statusEmoji[agent.status] ?? "\u26aa";
      lines.push(`${escapeMarkdownV2(emoji)} *${escapeMarkdownV2(agent.name)}* \\- ${escapeMarkdownV2(agent.status)}`);
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    await sendMessage(ctx, token, chatId, "Could not fetch agents. Make sure this chat is linked with /connect.", {
      messageThreadId,
    });
  }
}

async function handleApprove(
  ctx: PluginContext,
  token: string,
  chatId: string,
  approvalId: string,
  messageThreadId?: number,
  baseUrl = "http://localhost:3100",
) {
  if (!approvalId.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /approve <approval-id>", {
      messageThreadId,
    });
    return;
  }

  try {
    await ctx.http.fetch(`${baseUrl}/api/approvals/${approvalId.trim()}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedByUserId: `telegram:${chatId}` }),
    });

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\u2705")} *Approved*: \`${escapeMarkdownV2(approvalId.trim())}\``,
      { parseMode: "MarkdownV2", messageThreadId },
    );
  } catch (err) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to approve ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      { messageThreadId },
    );
  }
}

async function handleHelp(ctx: PluginContext, token: string, chatId: string, messageThreadId?: number) {
  const lines = [
    escapeMarkdownV2("\u{1f4ce}") + " *Paperclip Bot Commands*",
    "",
    ...BOT_COMMANDS.map((cmd) => `/${escapeMarkdownV2(cmd.command)} \\- ${escapeMarkdownV2(cmd.description)}`),
    "",
    `/${escapeMarkdownV2("connect")} \\- ${escapeMarkdownV2("Link this chat to a Paperclip company")}`,
    `/${escapeMarkdownV2("connect-topic")} \\- ${escapeMarkdownV2("Map a project to a forum topic")}`,
  ];

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

/**
 * FIX (PAP-148): handleConnect now resolves the company name to its UUID via
 * ctx.companies.list() and stores `companyId` (UUID) in state. Previously it
 * stored only the company *name*, which caused all subsequent SDK calls to fail
 * because they expected a UUID.
 */
async function handleConnect(
  ctx: PluginContext,
  token: string,
  chatId: string,
  companyName: string,
  messageThreadId?: number,
) {
  if (!companyName.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /connect <company-name>", {
      messageThreadId,
    });
    return;
  }

  const trimmedName = companyName.trim();

  // Resolve company name to UUID
  let companyId: string | undefined;
  try {
    const companies = await ctx.companies.list();
    const match = companies.find((c) => c.name.toLowerCase() === trimmedName.toLowerCase());
    if (!match) {
      await sendMessage(ctx, token, chatId, `Company "${trimmedName}" not found. Check the name and try again.`, {
        messageThreadId,
      });
      return;
    }
    companyId = match.id;
  } catch (err) {
    ctx.logger.error("Failed to resolve company name", { companyName: trimmedName, error: String(err) });
    await sendMessage(ctx, token, chatId, `Failed to look up company "${trimmedName}". Please try again.`, {
      messageThreadId,
    });
    return;
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `chat_${chatId}` },
    { companyId, companyName: trimmedName, linkedAt: new Date().toISOString() },
  );

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u{1f517}")} ${escapeMarkdownV2("Linked this chat to company:")} *${escapeMarkdownV2(trimmedName)}*`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
  ctx.logger.info("Chat linked to company", { chatId, companyName: trimmedName, companyId });
}

export async function handleConnectTopic(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(ctx, token, chatId, "Usage: /connect\\-topic <project\\-name> <topic\\-id>", {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const topicId = parts.pop()!;
  const projectName = parts.join(" ");

  const existing = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;

  const topicMap = existing ?? {};
  topicMap[projectName] = topicId;

  await ctx.state.set({ scopeKind: "instance", stateKey: `topic-map-${chatId}` }, topicMap);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u{1f517}")} ${escapeMarkdownV2(`Mapped project "${projectName}" to topic ${topicId}`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
  ctx.logger.info("Topic mapped", { chatId, projectName, topicId });
}

export async function getTopicForProject(
  ctx: PluginContext,
  chatId: string,
  projectName?: string,
): Promise<number | undefined> {
  if (!projectName) return undefined;
  const topicMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;
  if (!topicMap) return undefined;
  const topicId = topicMap[projectName];
  return topicId ? Number(topicId) : undefined;
}

/**
 * FIX (PAP-148): resolveCompanyId now returns the stored UUID (`companyId`)
 * instead of the company name. Falls back to chatId if no mapping exists.
 */
export async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  })) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? chatId;
}
