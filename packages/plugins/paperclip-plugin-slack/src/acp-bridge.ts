import type { PluginContext, AgentSessionEvent } from "@paperclipai/plugin-sdk";
import { postMessage, type SlackBlock } from "./slack-api.js";
import { formatAsBlocks } from "./formatters.js";
import { STATE_KEYS, DEFAULT_CONFIG, PLUGIN_ID } from "./constants.js";
import type {
  SessionEntry,
  DiscussionLoop,
  QueuedOutput,
} from "./types.js";

// --- Session registry (uses ctx.agents.sessions for native, state for ACP) ---
async function getSessions(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
): Promise<SessionEntry[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.sessionRegistry(channelId, threadTs),
  });
  if (Array.isArray(raw))
    return raw as SessionEntry[];
  return [];
}
async function setSessions(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  sessions: SessionEntry[],
): Promise<void> {
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.sessionRegistry(channelId, threadTs) }, sessions);
}
function findMostRecentActive(sessions: SessionEntry[]): SessionEntry | undefined {
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0)
    return undefined;
  return active.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())[0];
}
async function touchSession(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentName: string,
): Promise<void> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const session = sessions.find((s) => s.agentName === agentName && s.status === "active");
  if (session) {
    session.lastActivityAt = new Date().toISOString();
    await setSessions(ctx, companyId, channelId, threadTs, sessions);
  }
}
// --- Spawn agent: native sessions first, ACP fallback ---
export async function spawnAgent(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentId: string,
  displayName: string,
  reason?: string,
): Promise<SessionEntry | null> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const activeSessions = sessions.filter((s) => s.status === "active");
  const maxAgents = DEFAULT_CONFIG.maxAgentsPerThread;
  if (activeSessions.length >= maxAgents) {
    ctx.logger.warn("Max agents per thread reached", { channelId, threadTs, max: maxAgents });
    return null;
  }
  const existing = activeSessions.find((s) => s.agentName === agentId);
  if (existing) {
    ctx.logger.warn("Agent already active in thread", { agentName: agentId });
    return existing;
  }
  const taskKey = `slack-${channelId}-${threadTs}`;
  let transport: "native" | "acp" = "acp";
  let sessionId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Try native agent session first
    const nativeSession = await ctx.agents.sessions.create(agentId, companyId, {
      taskKey,
      reason: reason ?? `Spawned in Slack thread ${channelId}/${threadTs}`,
    });
    sessionId = nativeSession.sessionId;
    transport = "native";
    ctx.logger.info("Native agent session created", { agentId, sessionId });
  }
  catch (err) {
    // Fallback to ACP
    ctx.logger.info("Native session failed, falling back to ACP", { agentId, err });
    ctx.events.emit("acp-spawn", companyId, {
      agentId,
      channelId,
      threadTs,
      taskKey,
      reason: reason ?? `Spawned in Slack thread`,
    });
  }
  const now = new Date().toISOString();
  const entry: SessionEntry = {
    sessionId,
    agentId,
    agentName: agentId,
    agentDisplayName: displayName,
    transport,
    status: "active",
    spawnedAt: now,
    lastActivityAt: now,
  };
  sessions.push(entry);
  await setSessions(ctx, companyId, channelId, threadTs, sessions);
  return entry;
}
export async function closeAgent(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentName?: string,
): Promise<SessionEntry | null> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  let target: SessionEntry | undefined;
  if (agentName) {
    target = sessions.find((s) => s.status === "active" && s.agentName.toLowerCase() === agentName.toLowerCase());
  }
  else {
    target = findMostRecentActive(sessions);
  }
  if (!target)
    return null;
  // Close native session if applicable
  if (target.transport === "native") {
    try {
      await ctx.agents.sessions.close(target.sessionId, companyId);
    }
    catch (err) {
      ctx.logger.warn("Failed to close native session", { sessionId: target.sessionId, err });
    }
  }
  target.status = "closed";
  await setSessions(ctx, companyId, channelId, threadTs, sessions);
  return target;
}
// --- Message routing ---
function parseAtMention(text: string): string | null {
  const match = text.match(/@(\w[\w.-]*)/);
  return match ? match[1].toLowerCase() : null;
}
async function resolveTargetAgent(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  text: string,
  replyToAgentName?: string,
): Promise<SessionEntry | undefined> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0)
    return undefined;
  // 1. @mention
  const mentioned = parseAtMention(text);
  if (mentioned) {
    const match = active.find((s) => s.agentName.toLowerCase() === mentioned || s.agentDisplayName.toLowerCase() === mentioned);
    if (match)
      return match;
  }
  // 2. Reply-to agent
  if (replyToAgentName) {
    const match = active.find((s) => s.agentName === replyToAgentName);
    if (match)
      return match;
  }
  // 3. Most recently active
  return findMostRecentActive(active);
}
// --- Route inbound message to the right agent ---
export async function routeMessageToAgent(
  ctx: PluginContext,
  companyId: string,
  channel: string,
  threadTs: string,
  text: string,
  replyToMessageTs?: string,
): Promise<boolean> {
  const sessions = await getSessions(ctx, companyId, channel, threadTs);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0)
    return false;
  let replyToAgentName: string | undefined;
  if (replyToMessageTs) {
    const agentNameForMsg = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: STATE_KEYS.msgAgent(channel, replyToMessageTs),
    });
    if (agentNameForMsg) {
      replyToAgentName = String(agentNameForMsg);
    }
  }
  const target = await resolveTargetAgent(ctx, companyId, channel, threadTs, text, replyToAgentName);
  if (!target)
    return false;
  await touchSession(ctx, companyId, channel, threadTs, target.agentName);
  if (target.transport === "native") {
    // Use native session messaging - real SDK API
    await ctx.agents.sessions.sendMessage(target.sessionId, companyId, {
      prompt: text,
      reason: `Slack message in ${channel}/${threadTs}`,
      onEvent: (event: AgentSessionEvent) => {
        if (event.eventType === "chunk" && event.message) {
          // Streaming output handled via event listener
          ctx.events.emit("plugin.slack.agent-stream-chunk", companyId, {
            agentName: target.agentName,
            agentDisplayName: target.agentDisplayName,
            sessionId: target.sessionId,
            channel,
            threadTs,
            text: event.message,
          });
        }
      },
    });
  }
  else {
    // ACP fallback
    ctx.events.emit("acp-message", companyId, {
      agentId: target.agentName,
      sessionId: target.sessionId,
      channel,
      threadTs,
      text,
    });
  }
  ctx.logger.info("Routed message to agent", {
    agentId: target.agentName,
    transport: target.transport,
    channel,
    threadTs,
  });
  return true;
}
// --- Output sequencing ---
const activeSpeakers = new Map<string, string>();
async function enqueueOutput(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  output: QueuedOutput,
): Promise<void> {
  const key = STATE_KEYS.outputQueue(channelId, threadTs);
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: key,
  });
  const queue: QueuedOutput[] = Array.isArray(raw) ? (raw as QueuedOutput[]) : [];
  queue.push(output);
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: key }, queue);
}
async function drainOutputQueue(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const lockKey = `${channelId}_${threadTs}`;
  if (activeSpeakers.has(lockKey))
    return;
  const key = STATE_KEYS.outputQueue(channelId, threadTs);
  while (true) {
    const raw = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: key,
    });
    const queue: QueuedOutput[] = Array.isArray(raw) ? (raw as QueuedOutput[]) : [];
    if (queue.length === 0)
      break;
    const item = queue.shift()!;
    activeSpeakers.set(lockKey, item.agentName);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: key }, queue);
    const labelBlock = {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*[${item.agentDisplayName}]*` },
      ],
    };
    const contentBlocks = formatAsBlocks(item.text, item.toolName);
    const allBlocks = [labelBlock, ...contentBlocks];
    const message = {
      text: `[${item.agentDisplayName}] ${item.text.slice(0, 200)}`,
      blocks: allBlocks,
    };
    const result = await postMessage(ctx, token, channelId, message, { threadTs });
    if (result.ok && result.ts) {
      await ctx.state.set({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.msgAgent(channelId, result.ts),
      }, item.agentName);
    }
    activeSpeakers.delete(lockKey);
  }
}
// --- Handle agent output (from native onEvent or ACP events) ---
export async function handleAgentOutput(
  ctx: PluginContext,
  token: string,
  companyId: string,
  payload: {
    channel: string;
    threadTs: string;
    text: string;
    agentName?: string;
    agentDisplayName?: string;
    toolName?: string;
  },
): Promise<void> {
  const { channel, threadTs, text, toolName } = payload;
  const agentName = payload.agentName;
  const agentDisplayName = payload.agentDisplayName;
  if (!channel || !threadTs) {
    ctx.logger.warn("Agent output missing channel or threadTs", { channel, threadTs });
    return;
  }
  const sessions = await getSessions(ctx, companyId, channel, threadTs);
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length > 1 && agentName) {
    // Multi-agent: queue output for sequenced delivery
    const session = activeSessions.find((s) => s.agentName === agentName);
    const displayName = agentDisplayName ?? session?.agentDisplayName ?? agentName;
    await touchSession(ctx, companyId, channel, threadTs, agentName);
    await enqueueOutput(ctx, companyId, channel, threadTs, {
      agentName,
      agentDisplayName: displayName,
      text,
      toolName,
      queuedAt: new Date().toISOString(),
    });
    await drainOutputQueue(ctx, token, companyId, channel, threadTs);
  }
  else {
    // Single agent or legacy: post directly with optional label
    const blocks: Array<SlackBlock | Record<string, unknown>> = [];
    if (agentName && activeSessions.length > 0) {
      const session = activeSessions.find((s) => s.agentName === agentName);
      const displayName = agentDisplayName ?? session?.agentDisplayName ?? agentName;
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*[${displayName}]*` },
        ],
      });
      await touchSession(ctx, companyId, channel, threadTs, agentName);
    }
    blocks.push(...formatAsBlocks(text, toolName));
    const message = {
      text: text.slice(0, 200),
      blocks,
    };
    const result = await postMessage(ctx, token, channel, message, { threadTs });
    if (result.ok) {
      if (agentName && result.ts) {
        await ctx.state.set({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: STATE_KEYS.msgAgent(channel, result.ts),
        }, agentName);
      }
      await ctx.activity.log({
        companyId,
        message: "Posted agent output to Slack thread",
        entityType: "plugin",
        entityId: PLUGIN_ID,
      });
    }
  }
  // Advance discussion loop if applicable
  if (agentName) {
    await advanceDiscussionLoop(ctx, token, companyId, channel, threadTs, agentName, text);
  }
}
// --- Handoff tool ---
export function buildHandoffBlocks(
  fromAgent: string,
  toAgent: string,
  reason: string,
  handoffId: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent handoff requested*\n*${fromAgent}* wants to hand off to *${toAgent}*\n> ${reason}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "handoff_approve",
          value: handoffId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "handoff_reject",
          value: handoffId,
        },
      ],
    },
  ];
}
export async function handleHandoffAction(
  ctx: PluginContext,
  token: string,
  companyId: string,
  handoffId: string,
  approved: boolean,
  userId: string,
): Promise<void> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.handoff(handoffId),
  });
  if (!raw) {
    ctx.logger.warn("Handoff record not found", { handoffId });
    return;
  }
  const rawObj = raw as Record<string, unknown>;
  const status = approved ? "approved" : "rejected";
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.handoff(handoffId) }, { ...rawObj, status, resolvedBy: `slack:${userId}`, resolvedAt: new Date().toISOString() });
  if (approved) {
    const channelId = String(rawObj.channelId ?? "");
    const threadTs = String(rawObj.threadTs ?? "");
    const toAgent = String(rawObj.toAgent ?? "");
    const fromAgent = String(rawObj.fromAgent ?? "");
    const context = rawObj.context != null ? String(rawObj.context) : undefined;
    // Try to route via native session
    const sessions = await getSessions(ctx, companyId, channelId, threadTs);
    const targetSession = sessions.find((s) => s.agentName === toAgent && s.status === "active");
    if (targetSession && targetSession.transport === "native") {
      await ctx.agents.sessions.sendMessage(targetSession.sessionId, companyId, {
        prompt: context ?? `Handoff from ${fromAgent}: ${String(rawObj.reason ?? "")}`,
        reason: `Handoff from ${fromAgent}`,
      });
    }
    else {
      ctx.events.emit("acp-message", companyId, {
        agentId: toAgent,
        channel: channelId,
        threadTs,
        text: context ?? `Handoff from ${fromAgent}: ${String(rawObj.reason ?? "")}`,
        handoffId,
        fromAgent,
      });
    }
    ctx.logger.info("Handoff approved, message sent to target agent", {
      handoffId,
      fromAgent,
      toAgent,
    });
  }
  await ctx.metrics.write("slack.handoffs.resolved", 1, { decision: status });
}
// --- Discussion loop ---
export async function startDiscussion(
  ctx: PluginContext,
  token: string,
  companyId: string,
  params: {
    initiatorAgent: string;
    targetAgent: string;
    topic: string;
    channelId: string;
    threadTs: string;
    maxTurns: number;
  },
): Promise<{ discussionId: string; status: string }> {
  const { initiatorAgent, targetAgent, topic, channelId, threadTs, maxTurns } = params;
  const discussionId = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const loop: DiscussionLoop = {
    id: discussionId,
    channelId,
    threadTs,
    initiatorAgent,
    targetAgent,
    reason: topic,
    turns: 0,
    maxTurns,
    status: "active",
    lastTurnAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(discussionId) }, loop);
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.activeDiscussion(channelId, threadTs) }, discussionId);
  await postMessage(ctx, token, channelId, {
    text: `Discussion started: ${initiatorAgent} <-> ${targetAgent}: ${topic}`,
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `:speech_balloon: *Discussion started* between *${initiatorAgent}* and *${targetAgent}*` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Topic:* ${topic}\n*Max turns:* ${maxTurns}` },
      },
    ],
  }, threadTs ? { threadTs } : undefined);
  // Kick off: send topic to target agent via native or ACP
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const targetSession = sessions.find((s) => s.agentName === targetAgent && s.status === "active");
  if (targetSession && targetSession.transport === "native") {
    await ctx.agents.sessions.sendMessage(targetSession.sessionId, companyId, {
      prompt: `[Discussion with ${initiatorAgent}] ${topic}`,
      reason: `Discussion: ${topic}`,
    });
  }
  else {
    ctx.events.emit("acp-message", companyId, {
      agentId: targetAgent,
      channel: channelId,
      threadTs,
      text: `[Discussion with ${initiatorAgent}] ${topic}`,
      discussionId,
      fromAgent: initiatorAgent,
    });
  }
  return { discussionId, status: "active" };
}
async function advanceDiscussionLoop(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentName: string,
  text: string,
): Promise<void> {
  const activeDiscId = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.activeDiscussion(channelId, threadTs),
  });
  if (!activeDiscId)
    return;
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.discussion(String(activeDiscId)),
  });
  if (!raw || (raw as DiscussionLoop).status !== "active")
    return;
  const loop = raw as DiscussionLoop;
  loop.turns += 1;
  loop.lastTurnAt = new Date().toISOString();
  if (loop.turns >= loop.maxTurns) {
    loop.status = "completed";
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(loop.id) }, loop);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.activeDiscussion(channelId, threadTs) }, null);
    await postMessage(ctx, token, channelId, {
      text: `Discussion completed (${loop.turns} turns)`,
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `:white_check_mark: *Discussion completed* after ${loop.turns} turns` },
          ],
        },
      ],
    }, { threadTs });
    await ctx.metrics.write("slack.discussions.completed", 1, { turns: String(loop.turns) });
    return;
  }
  // Stale check (5 min)
  const staleCutoff = Date.now() - 5 * 60 * 1000;
  const lastTurn = new Date(loop.lastTurnAt).getTime();
  if (lastTurn < staleCutoff) {
    loop.status = "stale";
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(loop.id) }, loop);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.activeDiscussion(channelId, threadTs) }, null);
    await postMessage(ctx, token, channelId, {
      text: `Discussion went stale after ${loop.turns} turns`,
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `:hourglass: *Discussion paused* - no activity for 5 minutes (${loop.turns} turns)` },
          ],
        },
      ],
    }, { threadTs });
    return;
  }
  // Route to other agent
  const nextAgent = agentName === loop.initiatorAgent ? loop.targetAgent : loop.initiatorAgent;
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(loop.id) }, loop);
  // Human checkpoint every 5 turns
  if (loop.turns % 5 === 0) {
    loop.status = "paused";
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(loop.id) }, loop);
    await postMessage(ctx, token, channelId, {
      text: `Discussion checkpoint at turn ${loop.turns}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:pause_button: *Discussion checkpoint* (turn ${loop.turns}/${loop.maxTurns})\nReview the conversation and choose to continue or stop.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Continue" },
              style: "primary",
              action_id: "discussion_continue",
              value: loop.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Stop" },
              style: "danger",
              action_id: "discussion_stop",
              value: loop.id,
            },
          ],
        },
      ],
    }, { threadTs });
    return;
  }
  // Send to next agent via native or ACP
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const nextSession = sessions.find((s) => s.agentName === nextAgent && s.status === "active");
  if (nextSession && nextSession.transport === "native") {
    await ctx.agents.sessions.sendMessage(nextSession.sessionId, companyId, {
      prompt: `[Discussion with ${agentName}] ${text}`,
      reason: `Discussion turn ${loop.turns}`,
    });
  }
  else {
    ctx.events.emit("acp-message", companyId, {
      agentId: nextAgent,
      channel: channelId,
      threadTs,
      text: `[Discussion with ${agentName}] ${text}`,
      discussionId: loop.id,
      fromAgent: agentName,
    });
  }
}
export async function handleDiscussionAction(
  ctx: PluginContext,
  token: string,
  companyId: string,
  discussionId: string,
  action: "continue" | "stop",
  userId: string,
): Promise<void> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.discussion(discussionId),
  });
  if (!raw) {
    ctx.logger.warn("Discussion record not found", { discussionId });
    return;
  }
  const rawLoop = raw as DiscussionLoop;
  if (action === "stop") {
    rawLoop.status = "completed";
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(discussionId) }, rawLoop);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.activeDiscussion(rawLoop.channelId, rawLoop.threadTs) }, null);
    await ctx.metrics.write("slack.discussions.stopped", 1, { by: userId });
    return;
  }
  // Resume
  rawLoop.status = "active";
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.discussion(discussionId) }, rawLoop);
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.activeDiscussion(rawLoop.channelId, rawLoop.threadTs) }, discussionId);
  const nextAgent = rawLoop.turns % 2 === 0 ? rawLoop.targetAgent : rawLoop.initiatorAgent;
  const fromAgent = nextAgent === rawLoop.targetAgent ? rawLoop.initiatorAgent : rawLoop.targetAgent;
  const sessions = await getSessions(ctx, rawLoop.companyId ?? companyId, rawLoop.channelId, rawLoop.threadTs);
  const nextSession = sessions.find((s) => s.agentName === nextAgent && s.status === "active");
  if (nextSession && nextSession.transport === "native") {
    await ctx.agents.sessions.sendMessage(nextSession.sessionId, companyId, {
      prompt: "[Discussion resumed] Please continue the discussion.",
      reason: "Discussion resumed by user",
    });
  }
  else {
    ctx.events.emit("acp-message", companyId, {
      agentId: nextAgent,
      channel: rawLoop.channelId,
      threadTs: rawLoop.threadTs,
      text: "[Discussion resumed] Please continue the discussion.",
      discussionId,
      fromAgent,
    });
  }
}
// --- Slash command handler for /clip acp ---
export async function handleAcpSlashCommand(
  ctx: PluginContext,
  token: string,
  payload: {
    channel: string;
    threadTs: string;
    text: string;
    companyId: string;
  },
): Promise<void> {
  const subArgs = payload.text.trim().split(/\s+/);
  const sub = subArgs[0]?.toLowerCase() ?? "";
  if (sub === "spawn") {
    const agentName = subArgs[1];
    if (!agentName) {
      ctx.logger.warn("acp spawn requires an agent name");
      return;
    }
    const displayName = subArgs[2] ?? agentName;
    const entry = await spawnAgent(ctx, payload.companyId, payload.channel, payload.threadTs, agentName, displayName);
    if (entry) {
      await postMessage(ctx, token, payload.channel, {
        text: `Agent ${displayName} spawned (${entry.transport})`,
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `:robot_face: *${displayName}* joined the thread via ${entry.transport}` },
            ],
          },
        ],
      }, payload.threadTs ? { threadTs: payload.threadTs } : undefined);
    }
    return;
  }
  if (sub === "status") {
    const sessions = await getSessions(ctx, payload.companyId, payload.channel, payload.threadTs);
    const active = sessions.filter((s) => s.status === "active");
    if (active.length === 0) {
      await postMessage(ctx, token, payload.channel, {
        text: "No active agents in thread",
      }, payload.threadTs ? { threadTs: payload.threadTs } : undefined);
      return;
    }
    const lines = active.map((s) => {
      const age = Math.round((Date.now() - new Date(s.lastActivityAt).getTime()) / 1000);
      return `:large_green_circle: *${s.agentDisplayName}* (\`${s.agentName}\`) [${s.transport}] - last active ${age}s ago`;
    });
    await postMessage(ctx, token, payload.channel, {
      text: `${active.length} active agent(s) in thread`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `Active Agents (${active.length})` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: lines.join("\n") },
        },
      ],
    }, payload.threadTs ? { threadTs: payload.threadTs } : undefined);
    return;
  }
  if (sub === "close") {
    const targetName = subArgs[1]?.toLowerCase();
    const closed = await closeAgent(ctx, payload.companyId, payload.channel, payload.threadTs, targetName);
    if (closed) {
      await postMessage(ctx, token, payload.channel, {
        text: `Agent ${closed.agentDisplayName} closed`,
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `:wave: *${closed.agentDisplayName}* left the thread` },
            ],
          },
        ],
      }, payload.threadTs ? { threadTs: payload.threadTs } : undefined);
    }
    else {
      ctx.logger.warn("No matching agent to close", { targetName });
    }
    return;
  }
  ctx.logger.warn("Unknown /acp subcommand", { sub });
}
