import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { Goal, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

type GithubSyncConfig = {
  repo: string;
  host: string;
  secretRef: string;
  syncedGoalIds: string[];
  dryRun: boolean;
};

function parseConfig(raw: Record<string, unknown>): GithubSyncConfig {
  return {
    repo: String(raw["repo"] ?? ""),
    host: String(raw["host"] ?? "github.com"),
    secretRef: String(raw["secretRef"] ?? ""),
    syncedGoalIds: Array.isArray(raw["syncedGoalIds"])
      ? (raw["syncedGoalIds"] as string[])
      : [],
    dryRun: raw["dryRun"] !== false,
  };
}

/** Walk goal parentId chain; returns chain from the given goal up to root. */
async function resolveGoalAncestors(
  goalId: string,
  companyId: string,
  ctx: PluginContext,
): Promise<Array<Pick<Goal, "id" | "title" | "level">>> {
  const chain: Array<Pick<Goal, "id" | "title" | "level">> = [];
  let currentId: string | null = goalId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    try {
      const fetched = await ctx.goals.get(currentId, companyId);
      if (!fetched) break;
      chain.push({ id: fetched.id, title: fetched.title, level: fetched.level });
      currentId = fetched.parentId;
    } catch {
      break;
    }
  }

  return chain;
}

/** Strip event payload to safe metadata fields only (no PII, no secrets). */
function sanitizeEvent(event: PluginEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    entityId: event.entityId,
    entityType: event.entityType,
    actorType: event.actorType,
    companyId: event.companyId,
  };
}

async function handleSyncEvent(
  event: PluginEvent,
  ctx: PluginContext,
  config: GithubSyncConfig,
): Promise<void> {
  const safePayload = sanitizeEvent(event);

  const goalId =
    typeof (event.payload as Record<string, unknown>)?.["goalId"] === "string"
      ? ((event.payload as Record<string, unknown>)["goalId"] as string)
      : undefined;

  let goalAncestors: Array<Pick<Goal, "id" | "title" | "level">> = [];
  if (goalId) {
    try {
      goalAncestors = await resolveGoalAncestors(goalId, event.companyId, ctx);
    } catch (err) {
      ctx.logger.warn("github-sync: failed to resolve goal ancestors (best-effort)", {
        goalId,
        error: String(err),
      });
    }
  }

  ctx.logger.info("github-sync: received event (no-op)", {
    ...safePayload,
    config: {
      repo: config.repo,
      host: config.host,
      dryRun: config.dryRun,
      syncedGoalIdCount: config.syncedGoalIds.length,
    },
    goalAncestors,
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      const config = parseConfig(await ctx.config.get());
      await handleSyncEvent(event, ctx, config);
    });

    ctx.events.on("issue.updated", async (event) => {
      const config = parseConfig(await ctx.config.get());
      await handleSyncEvent(event, ctx, config);
    });

    ctx.events.on("goal.updated", async (event) => {
      const config = parseConfig(await ctx.config.get());
      await handleSyncEvent(event, ctx, config);
    });
  },

  async onHealth() {
    return { status: "ok", message: "github-sync plugin worker ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
