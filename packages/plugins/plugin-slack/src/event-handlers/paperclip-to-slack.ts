import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";
import type { SlackConfig } from "../types.js";
import { SlackClient } from "../slack-client.js";
import { buildAgentMaps, resolveToken } from "../sync/agent-mapper.js";
import {
  getThread,
  saveThread,
  saveThreadReverse,
  saveMessageTs,
} from "../sync/thread-mapper.js";
import {
  issueToSlackBlocks,
  commentToSlackText,
  statusChangeToSlackText,
} from "../utils/message-format.js";
import { PLUGIN_ID } from "../constants.js";

// ---------------------------------------------------------------------------
// Register all Paperclip → Slack event handlers
// ---------------------------------------------------------------------------

export function registerPaperclipEventHandlers(ctx: PluginContext): void {
  // New issue → post card to mapped Slack channel
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    await onIssueCreated(ctx, event).catch((err: unknown) => {
      ctx.logger.error("paperclip-to-slack: issue.created handler failed", { error: String(err) });
    });
  });

  // New comment → post as thread reply
  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    await onCommentCreated(ctx, event).catch((err: unknown) => {
      ctx.logger.error("paperclip-to-slack: issue.comment.created handler failed", { error: String(err) });
    });
  });

  // Issue updated → post status change to thread
  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    await onIssueUpdated(ctx, event).catch((err: unknown) => {
      ctx.logger.error("paperclip-to-slack: issue.updated handler failed", { error: String(err) });
    });
  });
}

// ---------------------------------------------------------------------------
// issue.created
// ---------------------------------------------------------------------------

async function onIssueCreated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  const issue = event.payload as Issue;

  const mapping = config.channelMappings?.find((m) => m.paperclipProjectId === issue.projectId) ?? null;

  if (!mapping) return; // no channel configured for this project

  const maps = buildAgentMaps(config);
  const token = resolveToken(config, maps, issue.assigneeAgentId ?? config.defaultAgentId);
  if (!token) return;

  const projectName = mapping.channelName ?? "Paperclip";
  const url = buildIssueUrl(issue.id);
  const client = new SlackClient(token, ctx.http);

  const res = await client.postMessage(
    mapping.slackChannelId,
    `New issue: ${issue.title}`,
    issueToSlackBlocks(issue, projectName, url),
  );

  await saveThread(ctx, issue.id, {
    channelId: mapping.slackChannelId,
    threadTs: res.ts,
    slackUrl: `https://slack.com/archives/${mapping.slackChannelId}/p${res.ts.replace(".", "")}`,
    createdAt: new Date().toISOString(),
  });
  await saveThreadReverse(ctx, mapping.slackChannelId, res.ts, issue.id);

  await ctx.activity.log({
    companyId: event.companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Issue posted to Slack #${mapping.channelName ?? mapping.slackChannelId}`,
    metadata: { plugin: PLUGIN_ID, slackChannel: mapping.slackChannelId, slackTs: res.ts },
  });
}

// ---------------------------------------------------------------------------
// issue.comment.created
// ---------------------------------------------------------------------------

async function onCommentCreated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  const comment = event.payload as IssueComment & { issueId: string; authorId?: string };

  const issueId: string = comment.issueId ?? (event as unknown as { entityId?: string }).entityId ?? "";
  if (!issueId) return;

  const thread = await getThread(ctx, issueId);
  if (!thread) return; // issue not tracked in Slack

  const maps = buildAgentMaps(config);
  const token = resolveToken(config, maps, comment.authorId ?? config.defaultAgentId);
  if (!token) return;

  const authorName =
    maps.agentIdToDisplay[comment.authorId ?? ""] ??
    comment.authorId ??
    "Paperclip";

  const client = new SlackClient(token, ctx.http);
  const res = await client.postMessage(
    thread.channelId,
    commentToSlackText(comment, authorName),
    undefined,
    thread.threadTs,
  );

  await saveMessageTs(ctx, comment.id, res.ts);
}

// ---------------------------------------------------------------------------
// issue.updated
// ---------------------------------------------------------------------------

async function onIssueUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);

  // The event payload contains { issue, changes } per Paperclip SDK conventions
  const payload = event.payload as {
    issue?: Issue;
    changes?: { status?: { old: string; new: string } };
  };

  const issue = payload.issue;
  const statusChange = payload.changes?.status;

  if (!issue || !statusChange) return;

  const thread = await getThread(ctx, issue.id);
  if (!thread) return;

  const maps = buildAgentMaps(config);
  const token = resolveToken(config, maps, issue.assigneeAgentId ?? config.defaultAgentId);
  if (!token) return;

  const client = new SlackClient(token, ctx.http);
  await client.postMessage(
    thread.channelId,
    statusChangeToSlackText(issue, statusChange.old, statusChange.new),
    undefined,
    thread.threadTs,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<SlackConfig> {
  return ctx.config.get() as Promise<SlackConfig>;
}

function buildIssueUrl(issueId: string): string {
  const base = process.env.PAPERCLIP_URL ?? "https://app.paperclip.ai";
  return `${base}/issues/${issueId}`;
}
