import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { createGoalSubtreeCache, isGoalInSyncedSubtree } from "./goal-subtree-cache.js";
import { createSyncEngine, type SyncEngineConfig } from "./sync-engine.js";

type GithubSyncConfig = SyncEngineConfig & {
  syncedGoalIds: string[];
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

function safeMeta(event: PluginEvent): Record<string, unknown> {
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

async function routeEvent(
  event: PluginEvent,
  ctx: PluginContext,
  config: GithubSyncConfig,
  cache: ReturnType<typeof createGoalSubtreeCache>,
  engine: ReturnType<typeof createSyncEngine>,
): Promise<void> {
  const meta = safeMeta(event);
  const issueId = event.entityId;

  if (!issueId) {
    ctx.logger.warn("github-sync: event has no entityId, skipping", meta);
    return;
  }

  const goalId =
    typeof (event.payload as Record<string, unknown>)?.["goalId"] === "string"
      ? ((event.payload as Record<string, unknown>)["goalId"] as string)
      : undefined;

  if (!goalId && config.syncedGoalIds.length > 0) {
    ctx.logger.info("github-sync: issue has no goalId — out of synced goal subtree, skipping", meta);
    return;
  }

  if (goalId) {
    let inScope: boolean;
    try {
      inScope = await isGoalInSyncedSubtree(goalId, event.companyId, config.syncedGoalIds, cache, ctx);
    } catch (err) {
      ctx.logger.warn("github-sync: failed to resolve goal subtree, skipping", {
        ...meta,
        goalId,
        error: String(err),
      });
      return;
    }

    if (!inScope) {
      ctx.logger.info("github-sync: issue out of synced goal subtree, skipping", {
        ...meta,
        goalId,
      });
      return;
    }
  }

  engine.scheduleSync(issueId, event.companyId, ctx, config);
}

const plugin = definePlugin({
  async setup(ctx) {
    const cache = createGoalSubtreeCache();
    const engine = createSyncEngine();

    ctx.events.on("issue.created", async (event) => {
      const config = parseConfig(await ctx.config.get());
      await routeEvent(event, ctx, config, cache, engine);
    });

    ctx.events.on("issue.updated", async (event) => {
      const config = parseConfig(await ctx.config.get());
      await routeEvent(event, ctx, config, cache, engine);
    });

    ctx.events.on("goal.updated", async (event) => {
      cache.invalidate(event.companyId);
      ctx.logger.info("github-sync: goal.updated — cache invalidated", {
        companyId: event.companyId,
        entityId: event.entityId,
      });
    });
  },

  async onHealth() {
    return { status: "ok", message: "github-sync plugin worker ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
