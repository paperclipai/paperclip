import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import {
  MAX_AGENTS_PER_THREAD,
  DEFAULT_CONVERSATION_TURNS,
  MAX_CONVERSATION_TURNS,
  ACP_SPAWN_EVENT,
  ACP_OUTPUT_EVENT,
} from "./constants.js";
import type {
  AcpSession,
  AcpOutputEvent,
  HandoffToolParams,
  StoredHandoff,
  DiscussToolParams,
  AgentMessageMapping,
} from "./types.js";

// --- Setup: register ACP output listener ---
export function setupAcpOutputListener(ctx: PluginContext, token: string) {
  ctx.events.on(ACP_OUTPUT_EVENT as "issue.created", async (event) => {
    await handleAcpOutput(ctx, token, event.payload as unknown as AcpOutputEvent);
  });
}

// --- ACP command handler ---
export async function handleAcpCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
  companyId?: string,
) {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "spawn":
      await handleAcpSpawn(ctx, token, chatId, parts.slice(1).join(" "), messageThreadId, companyId);
      break;
    case "status":
      await handleAcpStatus(ctx, token, chatId, messageThreadId);
      break;
    case "cancel":
      await handleAcpCancel(ctx, token, chatId, messageThreadId, companyId);
      break;
    case "close":
      await handleAcpClose(ctx, token, chatId, parts.slice(1).join(" ").trim(), messageThreadId, companyId);
      break;
    default:
      await sendMessage(
        ctx,
        token,
        chatId,
        [
          escapeMarkdownV2("\u{1f50c}") + " *ACP Commands*",
          "",
          `/acp spawn <agent\\-name> \\- ${escapeMarkdownV2("Start an agent session in this thread")}`,
          `/acp status \\- ${escapeMarkdownV2("Show all agent sessions in this thread")}`,
          `/acp cancel \\- ${escapeMarkdownV2("Cancel the running agent task")}`,
          `/acp close [agent\\-name] \\- ${escapeMarkdownV2("End an agent session (most recent if no name given)")}`,
        ].join("\n"),
        { parseMode: "MarkdownV2", messageThreadId },
      );
  }
}

async function handleAcpSpawn(
  ctx: PluginContext,
  token: string,
  chatId: string,
  agentName: string,
  messageThreadId?: number,
  companyId?: string,
) {
  if (!agentName.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /acp spawn <agent-name>", { messageThreadId });
    return;
  }
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Agent sessions must be started inside a topic thread.", { messageThreadId });
    return;
  }

  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length >= MAX_AGENTS_PER_THREAD) {
    const listing = activeSessions.map((s) => `  - ${s.agentDisplayName} (${s.transport})`).join("\n");
    await sendMessage(
      ctx,
      token,
      chatId,
      `Thread already has ${MAX_AGENTS_PER_THREAD} active agents (max):\n${listing}`,
      { messageThreadId },
    );
    return;
  }

  await sendChatAction(ctx, token, chatId);
  const trimmedName = agentName.trim();
  const displayName = trimmedName.charAt(0).toUpperCase() + trimmedName.slice(1);
  const resolvedCompanyId = companyId ?? (await resolveCompanyIdFromChat(ctx, chatId));

  let transport = "acp";
  let sessionId: string;
  let agentId = "";
  try {
    const agent = await ctx.agents.get(trimmedName, resolvedCompanyId);
    if (agent) {
      agentId = agent.id;
      const session = await ctx.agents.sessions.create(agentId, resolvedCompanyId, {
        reason: `Telegram thread ${chatId}/${messageThreadId}`,
      });
      sessionId = session.sessionId;
      transport = "native";
    } else {
      sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  } catch {
    sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const now = new Date().toISOString();
  sessions.push({
    sessionId,
    agentId,
    agentName: trimmedName,
    agentDisplayName: displayName,
    transport,
    spawnedAt: now,
    status: "active",
    lastActivityAt: now,
  });
  await saveSessions(ctx, chatId, messageThreadId, sessions);

  if (transport === "acp") {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "spawn",
      sessionId,
      agentName: trimmedName,
      chatId,
      threadId: messageThreadId,
    });
  }

  const agentCount = activeSessions.length + 1;
  const transportLabel = transport === "native" ? "Paperclip" : "ACP";
  const agentCountLine =
    agentCount > 1
      ? `\n${escapeMarkdownV2(`${agentCount} agents now active in this thread. Use @${trimmedName} to address directly.`)}`
      : "";

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("\u{1f50c}") + " *Agent Session Started*",
      "",
      `Agent: *${escapeMarkdownV2(displayName)}*`,
      `Transport: *${escapeMarkdownV2(transportLabel)}*`,
      `Session: \`${escapeMarkdownV2(sessionId)}\``,
      "",
      escapeMarkdownV2("Send messages in this thread to interact with the agent."),
      agentCountLine,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );
  ctx.logger.info("Agent session spawned", {
    sessionId,
    agentName: trimmedName,
    transport,
    chatId,
    threadId: messageThreadId,
  });
}

async function handleAcpStatus(ctx: PluginContext, token: string, chatId: string, messageThreadId?: number) {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp status inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }
  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", { messageThreadId });
    return;
  }
  const lines = [escapeMarkdownV2("\u{1f50c}") + ` *Agent Sessions \\(${activeSessions.length}\\)*`, ""];
  for (const session of activeSessions) {
    lines.push(
      `${escapeMarkdownV2("\u{1f916}")} *${escapeMarkdownV2(session.agentDisplayName)}* \\[${escapeMarkdownV2(session.transport)}\\]`,
      `  Session: \`${escapeMarkdownV2(session.sessionId)}\``,
      `  Started: ${escapeMarkdownV2(session.spawnedAt)}`,
      `  Last active: ${escapeMarkdownV2(session.lastActivityAt)}`,
      "",
    );
  }
  await sendMessage(ctx, token, chatId, lines.join("\n"), { parseMode: "MarkdownV2", messageThreadId });
}

async function handleAcpCancel(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  companyId?: string,
) {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp cancel inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }
  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", { messageThreadId });
    return;
  }
  const target = mostRecentSession(activeSessions);
  const resolvedCompanyId = companyId ?? (await resolveCompanyIdFromChat(ctx, chatId));
  if (target.transport === "native") {
    try {
      await ctx.agents.sessions.close(target.sessionId, resolvedCompanyId);
    } catch (err) {
      ctx.logger.error("Failed to close native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "cancel",
      sessionId: target.sessionId,
      chatId,
      threadId: messageThreadId,
    });
  }
  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u23f9")} Cancellation requested for *${escapeMarkdownV2(target.agentDisplayName)}* \\(\`${escapeMarkdownV2(target.sessionId)}\`\\)`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function handleAcpClose(
  ctx: PluginContext,
  token: string,
  chatId: string,
  targetAgentName: string,
  messageThreadId?: number,
  companyId?: string,
) {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp close inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }
  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", { messageThreadId });
    return;
  }
  let targetSession: AcpSession | undefined;
  if (targetAgentName) {
    const lowerTarget = targetAgentName.toLowerCase();
    targetSession =
      activeSessions.find((s) => s.agentName.toLowerCase() === lowerTarget) ??
      activeSessions.find((s) => s.agentName.toLowerCase().includes(lowerTarget));
    if (!targetSession) {
      await sendMessage(ctx, token, chatId, `No agent named "${targetAgentName}" found.`, { messageThreadId });
      return;
    }
  } else {
    targetSession = mostRecentSession(activeSessions);
  }
  const resolvedCompanyId = companyId ?? (await resolveCompanyIdFromChat(ctx, chatId));
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.close(targetSession.sessionId, resolvedCompanyId);
    } catch (err) {
      ctx.logger.error("Failed to close native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "close",
      sessionId: targetSession.sessionId,
      chatId,
      threadId: messageThreadId,
    });
  }
  const idx = sessions.findIndex((s) => s.sessionId === targetSession!.sessionId);
  if (idx >= 0) sessions[idx].status = "closed";
  await saveSessions(ctx, chatId, messageThreadId, sessions);
  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u{1f50c}")} Session for *${escapeMarkdownV2(targetSession.agentDisplayName)}* closed\\.`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

// --- Multi-agent message routing ---
export async function routeMessageToAgent(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  text: string,
  replyToMessageId: number | undefined,
  companyId: string,
): Promise<boolean> {
  const sessions = await getSessions(ctx, chatId, threadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0) return false;

  let targetSession: AcpSession | undefined;
  const mentionMatch = text.match(/@(\w+)/);
  if (mentionMatch) {
    const mentionName = mentionMatch[1].toLowerCase();
    targetSession = activeSessions.find(
      (s) => s.agentName.toLowerCase() === mentionName || s.agentDisplayName?.toLowerCase() === mentionName,
    );
  }
  if (!targetSession && replyToMessageId) {
    const agentMapping = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: `agent_msg_${chatId}_${replyToMessageId}`,
    })) as AgentMessageMapping | null;
    if (agentMapping) targetSession = activeSessions.find((s) => s.sessionId === agentMapping.sessionId);
  }
  if (!targetSession) targetSession = mostRecentSession(activeSessions);

  targetSession.lastActivityAt = new Date().toISOString();
  const idx = sessions.findIndex((s) => s.sessionId === targetSession!.sessionId);
  if (idx >= 0) sessions[idx] = targetSession;
  await saveSessions(ctx, chatId, threadId, sessions);

  const resolvedCompanyId = companyId ?? (await resolveCompanyIdFromChat(ctx, chatId));
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.sendMessage(targetSession.sessionId, resolvedCompanyId, {
        prompt: text,
        reason: "telegram_message",
      });
    } catch (err) {
      ctx.logger.error("Failed to send message to native session", { error: String(err) });
      return false;
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "message",
      sessionId: targetSession.sessionId,
      chatId,
      threadId,
      text,
    });
  }
  return true;
}

// --- ACP output handler ---
export async function handleAcpOutput(ctx: PluginContext, token: string, event: AcpOutputEvent) {
  const { sessionId, chatId, threadId, text, done } = event;
  const sessions = await getSessions(ctx, chatId, threadId);
  const session = sessions.find((s) => s.sessionId === sessionId);
  const displayName = session?.agentDisplayName ?? "Agent";

  if (session) {
    session.lastActivityAt = new Date().toISOString();
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx >= 0) sessions[idx] = session;
    await saveSessions(ctx, chatId, threadId, sessions);
  }

  const prefix = done ? escapeMarkdownV2("\u2705") : escapeMarkdownV2("\u{1f916}");
  const label = `*\\[${escapeMarkdownV2(displayName)}\\]*`;
  const messageId = await sendMessage(ctx, token, chatId, `${prefix} ${label} ${escapeMarkdownV2(text)}`, {
    parseMode: "MarkdownV2",
    messageThreadId: threadId,
  });
  if (messageId) {
    await ctx.state.set({ scopeKind: "instance", stateKey: `agent_msg_${chatId}_${messageId}` }, {
      sessionId,
    } satisfies AgentMessageMapping);
  }
}

// --- Handoff / discuss tool handlers ---
export async function handleHandoffToolCall(
  ctx: PluginContext,
  token: string,
  params: HandoffToolParams,
  companyId: string,
  sourceAgentId: string,
) {
  const targetAgent = String(params.targetAgent ?? "");
  const reason = String(params.reason ?? "");
  const contextSummary = String(params.contextSummary ?? "");
  const chatId = String(params.chatId ?? "");
  const threadId = Number(params.threadId ?? 0);
  if (!targetAgent || !chatId || !threadId) return { error: "Missing required fields" };

  const sessions = await getSessions(ctx, chatId, threadId);
  const sourceSession = sessions.find((s) => s.agentId === sourceAgentId);
  const sourceAgent = sourceSession?.agentDisplayName ?? "Agent";
  const handoffId = `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const handoffText = `${escapeMarkdownV2("\u{1f504}")} *\\[${escapeMarkdownV2(sourceAgent)}\\]* ${escapeMarkdownV2("Handing off to")} *${escapeMarkdownV2(targetAgent)}*\n\n${escapeMarkdownV2("Reason:")} ${escapeMarkdownV2(reason)}`;

  if (params.requiresApproval !== false) {
    await sendMessage(ctx, token, chatId, handoffText, {
      parseMode: "MarkdownV2",
      messageThreadId: threadId,
      inlineKeyboard: [
        [
          { text: "Approve", callback_data: `handoff_approve_${handoffId}` },
          { text: "Reject", callback_data: `handoff_reject_${handoffId}` },
        ],
      ],
    });
    const stored: StoredHandoff = {
      handoffId,
      sourceSessionId: sourceSession?.sessionId ?? "",
      sourceAgent,
      targetAgent,
      reason,
      contextSummary,
      chatId,
      threadId,
      companyId,
    };
    await ctx.state.set({ scopeKind: "instance", stateKey: `handoff_${handoffId}` }, stored);
    return { content: JSON.stringify({ status: "pending_approval", handoffId }) };
  }

  await sendMessage(ctx, token, chatId, handoffText, { parseMode: "MarkdownV2", messageThreadId: threadId });
  return { content: JSON.stringify({ status: "handed_off", handoffId }) };
}

export async function handleHandoffApproval(
  ctx: PluginContext,
  token: string,
  handoffId: string,
  actor: string,
  callbackQueryId: string,
  chatId: string | null,
  messageId: number | undefined,
) {
  const pending = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `handoff_${handoffId}`,
  })) as StoredHandoff | null;
  if (!pending) return;
  await ctx.state.set({ scopeKind: "instance", stateKey: `handoff_${handoffId}` }, null);
  ctx.logger.info("Handoff approved", { handoffId, actor, targetAgent: pending.targetAgent });
}

export async function handleHandoffRejection(
  ctx: PluginContext,
  token: string,
  handoffId: string,
  actor: string,
  callbackQueryId: string,
  chatId: string | null,
  messageId: number | undefined,
) {
  const pending = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `handoff_${handoffId}`,
  })) as StoredHandoff | null;
  if (!pending) return;
  await sendMessage(
    ctx,
    token,
    pending.chatId,
    `${escapeMarkdownV2("\u274c")} Handoff to *${escapeMarkdownV2(pending.targetAgent)}* rejected by ${escapeMarkdownV2(actor)}`,
    { parseMode: "MarkdownV2", messageThreadId: pending.threadId },
  );
  await ctx.state.set({ scopeKind: "instance", stateKey: `handoff_${handoffId}` }, null);
}

export async function handleDiscussToolCall(
  ctx: PluginContext,
  token: string,
  params: DiscussToolParams,
  companyId: string,
  sourceAgentId: string,
) {
  const targetAgent = String(params.targetAgent ?? "");
  const topic = String(params.topic ?? "");
  const initialMessage = String(params.initialMessage ?? "");
  const maxTurns = Math.min(Number(params.maxTurns ?? DEFAULT_CONVERSATION_TURNS), MAX_CONVERSATION_TURNS);
  const chatId = String(params.chatId ?? "");
  const threadId = Number(params.threadId ?? 0);
  if (!targetAgent || !initialMessage || !chatId || !threadId) return { error: "Missing required fields" };

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      `${escapeMarkdownV2("\u{1f4ac}")} *Discussion Started*`,
      "",
      `Topic: ${escapeMarkdownV2(topic)}`,
      `Max turns: ${escapeMarkdownV2(String(maxTurns))}`,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId: threadId },
  );

  return { content: JSON.stringify({ status: "started", maxTurns }) };
}

// --- Session state helpers ---
export async function getSessions(
  ctx: PluginContext,
  chatId: string,
  threadId: number | undefined,
): Promise<AcpSession[]> {
  const sessions = await ctx.state.get({ scopeKind: "instance", stateKey: `sessions_${chatId}_${threadId}` });
  return (sessions as AcpSession[]) ?? [];
}

async function saveSessions(ctx: PluginContext, chatId: string, threadId: number, sessions: AcpSession[]) {
  await ctx.state.set({ scopeKind: "instance", stateKey: `sessions_${chatId}_${threadId}` }, sessions);
}

function mostRecentSession(sessions: AcpSession[]): AcpSession {
  return sessions.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())[0];
}

/**
 * FIX (PAP-148): resolveCompanyIdFromChat now returns the stored UUID
 * (`companyId`) instead of the company name. Falls back to chatId if no
 * mapping exists.
 */
async function resolveCompanyIdFromChat(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  })) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? chatId;
}
