import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postMessage } from "./slack-api.js";
import type { WatchEntry } from "./types.js";

// --- Watch registry ---
const WATCHES_LIST_KEY = "global-watches-list";
async function getAllWatches(ctx: PluginContext): Promise<WatchEntry[]> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: WATCHES_LIST_KEY,
  });
  if (Array.isArray(raw))
    return raw as WatchEntry[];
  return [];
}
async function setAllWatches(ctx: PluginContext, watches: WatchEntry[]): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", scopeId: "global", stateKey: WATCHES_LIST_KEY }, watches);
}
export async function registerWatch(
  ctx: PluginContext,
  companyId: string,
  watch: Omit<WatchEntry, "id" | "createdAt" | "triggerCount">,
): Promise<WatchEntry> {
  const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: WatchEntry = {
    ...watch,
    id,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
  };
  const watches = await getAllWatches(ctx);
  watches.push(entry);
  await setAllWatches(ctx, watches);
  ctx.logger.info("Watch registered", { id, eventPattern: watch.eventPattern, agentId: watch.agentId });
  return entry;
}
export async function removeWatch(ctx: PluginContext, watchId: string): Promise<boolean> {
  const watches = await getAllWatches(ctx);
  const filtered = watches.filter((w) => w.id !== watchId);
  if (filtered.length === watches.length)
    return false;
  await setAllWatches(ctx, filtered);
  return true;
}
export async function listWatches(ctx: PluginContext, companyId?: string): Promise<WatchEntry[]> {
  const watches = await getAllWatches(ctx);
  if (companyId)
    return watches.filter((w) => w.companyId === companyId);
  return watches;
}
// --- Built-in sales templates ---
export const BUILTIN_WATCH_TEMPLATES: Array<{
  name: string;
  eventPattern: string;
  prompt: string;
  description: string;
}> = [
  {
    name: "new-lead-follow-up",
    eventPattern: "lead.created",
    prompt: "A new lead was created: ${event.payload.name} (${event.payload.email}). Draft a personalized follow-up message based on their profile and recent activity.",
    description: "Auto-draft follow-up when a new lead is created",
  },
  {
    name: "deal-stalled",
    eventPattern: "deal.stalled",
    prompt: "Deal ${event.payload.dealName} has been stalled for ${event.payload.stalledDays} days. Suggest re-engagement strategies based on the deal history.",
    description: "Suggest re-engagement when a deal goes stale",
  },
  {
    name: "high-value-issue",
    eventPattern: "issue.created",
    prompt: "A new high-priority issue was created: ${event.payload.title}. Analyze the issue and suggest a resolution approach with estimated effort.",
    description: "Auto-analyze high-priority issues",
  },
  {
    name: "budget-warning",
    eventPattern: "cost_event.created",
    prompt: "Agent ${event.payload.agentName} has reached ${event.payload.percentUsed}% of budget. Recommend cost optimization strategies.",
    description: "Suggest cost optimizations when budget threshold hit",
  },
  {
    name: "agent-error-diagnosis",
    eventPattern: "agent.run.failed",
    prompt: "Agent ${event.payload.agentName} failed with: ${event.payload.error}. Diagnose the likely root cause and suggest a fix.",
    description: "Auto-diagnose agent failures",
  },
];
// --- Check watches job (runs on schedule) ---
export async function checkWatches(
  ctx: PluginContext,
  token: string,
  companyId: string,
  recentEvents: Array<{
    eventType: string;
    payload: Record<string, unknown>;
  }>,
): Promise<number> {
  const watches = await getAllWatches(ctx);
  const companyWatches = watches.filter((w) => w.companyId === companyId);
  let triggered = 0;
  for (const watch of companyWatches) {
    for (const event of recentEvents) {
      if (!matchesPattern(event.eventType, watch.eventPattern))
        continue;
      // Interpolate prompt with event data
      const prompt = interpolateEventData(watch.prompt, event);
      try {
        // Invoke the configured agent
        const result = await ctx.agents.invoke(watch.agentId, companyId, {
          prompt,
          reason: `Proactive watch trigger: ${watch.eventPattern}`,
        });
        // Post notification to the watch's channel/thread
        await postMessage(ctx, token, watch.channelId, {
          text: `Watch triggered: ${watch.eventPattern}`,
          blocks: [
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `:bell: *Watch triggered:* \`${watch.eventPattern}\`` },
              ],
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Agent *${watch.agentId}* invoked (run: \`${result.runId}\`)`,
              },
            },
          ],
        }, watch.threadTs ? { threadTs: watch.threadTs } : undefined);
        // Update trigger count
        watch.triggerCount += 1;
        watch.lastTriggeredAt = new Date().toISOString();
        triggered++;
        ctx.logger.info("Watch triggered", {
          watchId: watch.id,
          eventType: event.eventType,
          runId: result.runId,
        });
      }
      catch (err) {
        ctx.logger.warn("Watch trigger failed", { watchId: watch.id, err });
      }
    }
  }
  if (triggered > 0) {
    await setAllWatches(ctx, watches);
    await ctx.metrics.write("slack.watches.triggered", triggered);
  }
  return triggered;
}
// --- Pattern matching ---
function matchesPattern(eventType: string, pattern: string): boolean {
  // Support exact match and wildcard patterns
  if (pattern === eventType)
    return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + ".");
  }
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return regex.test(eventType);
  }
  return false;
}
function interpolateEventData(
  template: string,
  event: { eventType: string; payload: Record<string, unknown> },
): string {
  let result = template;
  result = result.replace(/\$\{event\.eventType\}/g, event.eventType);
  // Replace ${event.payload.key} patterns
  const payloadPattern = /\$\{event\.payload\.(\w+)\}/g;
  result = result.replace(payloadPattern, (_match, key) => {
    const value = event.payload[key];
    return value != null ? String(value) : "";
  });
  return result;
}
