import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ThreadEntry } from "../types.js";

const NS = "slack";

// ---------------------------------------------------------------------------
// Thread map  (issueId → Slack thread root)
// ---------------------------------------------------------------------------

export async function getThread(
  ctx: PluginContext,
  issueId: string,
): Promise<ThreadEntry | null> {
  return ctx.state.get({
    scopeKind: "instance",
    namespace: NS,
    stateKey: `thread:${issueId}`,
  }) as Promise<ThreadEntry | null>;
}

export async function saveThread(
  ctx: PluginContext,
  issueId: string,
  entry: ThreadEntry,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", namespace: NS, stateKey: `thread:${issueId}` },
    entry,
  );
}

// ---------------------------------------------------------------------------
// Thread reverse index  (channelId:threadTs → issueId)
// ---------------------------------------------------------------------------

export async function getIssueIdForThread(
  ctx: PluginContext,
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  return ctx.state.get({
    scopeKind: "instance",
    namespace: NS,
    stateKey: `rev:${channelId}:${threadTs}`,
  }) as Promise<string | null>;
}

export async function saveThreadReverse(
  ctx: PluginContext,
  channelId: string,
  threadTs: string,
  issueId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", namespace: NS, stateKey: `rev:${channelId}:${threadTs}` },
    issueId,
  );
}

// ---------------------------------------------------------------------------
// Message map  (commentId → Slack message ts)
// ---------------------------------------------------------------------------

export async function getMessageTs(
  ctx: PluginContext,
  commentId: string,
): Promise<string | null> {
  return ctx.state.get({
    scopeKind: "instance",
    namespace: NS,
    stateKey: `msg:${commentId}`,
  }) as Promise<string | null>;
}

export async function saveMessageTs(
  ctx: PluginContext,
  commentId: string,
  ts: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", namespace: NS, stateKey: `msg:${commentId}` },
    ts,
  );
}

// ---------------------------------------------------------------------------
// Deduplication  (Slack event IDs — prevent double-processing)
// ---------------------------------------------------------------------------

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function isEventProcessed(
  ctx: PluginContext,
  eventId: string,
): Promise<boolean> {
  const val = await ctx.state.get({
    scopeKind: "instance",
    namespace: `${NS}:dedup`,
    stateKey: eventId,
  }) as { processedAt: number } | null;
  if (!val) return false;
  return Date.now() - val.processedAt < DEDUP_TTL_MS;
}

export async function markEventProcessed(
  ctx: PluginContext,
  eventId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", namespace: `${NS}:dedup`, stateKey: eventId },
    { processedAt: Date.now() },
  );
}
