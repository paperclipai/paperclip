import { and, asc, eq, isNull, or } from "drizzle-orm";
import { pluginCompanySettings, pluginConfig, plugins, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pluginLifecycleInbox } from "./plugin-lifecycle-inbox.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;

/** The journal is the queue. Notifications only wake its single local dispatcher. */
export function registerPluginLifecycleDelivery(
  coordinator: Coordinator,
  db: Db,
  manager: Pick<PluginWorkerManager, "call" | "isRunning" | "onConfigApplied">,
  lifecycle: Pick<PluginLifecycleManager, "on" | "off">,
) {
  // Startup and every wake remain pending until an admitted run inspects the inbox.
  // The coordinator may reconcile signals while idle drain prevents dispatch.
  let pending = true;
  const retryAt = new Map<string, number>();
  const retryMs = 30_000;
  const delivery = coordinator.register(DELIVERY_QUEUES.pluginLifecycle, {
    retryMs,
    hasPending: async () => pending,
    onSettled: () => { pending = true; },
    nextRunAt() {
      if (!pending) return null;
      let next: number | null = null;
      for (const at of retryAt.values()) {
        // An expired deadline during idle drain must not schedule a busy loop.
        if (at > Date.now() && (next === null || at < next)) next = at;
      }
      return next;
    },
    async run(signal) {
      pending = false;
      try {
        for (const [key, at] of retryAt) if (at <= Date.now()) retryAt.delete(key);
        const configured = await db.select({ plugin: plugins, companyId: pluginConfig.companyId })
          .from(plugins).innerJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
          .where(eq(plugins.status, "ready"))
          .orderBy(asc(plugins.installOrder), asc(pluginConfig.companyId));
        for (const { plugin, companyId } of configured) {
          const types = plugin.manifestJson.resourceLifecycle;
          if (!types?.length || !plugin.manifestJson.capabilities.includes("events.subscribe")) continue;
          const [disabled] = await db.select({ id: pluginCompanySettings.id }).from(pluginCompanySettings)
            .where(and(eq(pluginCompanySettings.pluginId, plugin.id), eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.enabled, false)));
          if (disabled) continue;
          const inbox = pluginLifecycleInbox(db, plugin.id);
          let afterId: string | undefined;
          // Visit independent resources past a failed or deferred head.
          for (;;) {
            if (signal.aborted) return;
            const events = await inbox.list(companyId, 100, afterId, types);
            for (const event of events) {
              if (signal.aborted) return;
              const retryKey = `${plugin.id}:${event.id}`;
              if (retryAt.has(retryKey)) { pending = true; continue; }
              if (!manager.isRunning(plugin.id)) { pending = true; break; }
              let stage = "eligibility";
              try {
                // Recheck enablement for each invocation; a disable during a batch must stop delivery.
                const [enabled] = await db.select({ manifest: plugins.manifestJson }).from(plugins)
                  .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, companyId)))
                  .where(and(eq(plugins.id, plugin.id), eq(plugins.status, "ready"),
                    or(isNull(pluginCompanySettings.enabled), eq(pluginCompanySettings.enabled, true))));
                if (!enabled?.manifest.resourceLifecycle?.includes(event.resourceType) || !enabled.manifest.capabilities.includes("events.subscribe")) break;
                stage = "callback";
                const result = await manager.call(plugin.id, "resourceLifecycle", event, 30_000);
                stage = "result";
                if (result?.eventId !== event.id || !["acknowledged", "retry", "deferred"].includes(result.status)) {
                  throw new Error("Invalid resource lifecycle result");
                }
                if (signal.aborted) return;
                if (result.status === "acknowledged") {
                  stage = "acknowledgment";
                  await inbox.acknowledge(companyId, event.id);
                  // An acknowledgment exposes the next event for this resource. Drain immediately.
                  wake();
                } else if (result.status === "retry") {
                  retryAt.set(retryKey, Date.now() + retryMs);
                  pending = true;
                }
              } catch (error) {
                retryAt.set(retryKey, Date.now() + retryMs);
                // Provider error messages/data may contain secrets; retain only routing
                // identifiers, the failed stage, and the protocol's numeric error code.
                const code = (error as { code?: unknown } | null)?.code;
                logger.warn({ pluginId: plugin.id, companyId, eventId: event.id, stage,
                  ...(typeof code === "number" ? { rpcCode: code } : {}) }, "Resource lifecycle delivery failed; retry scheduled");
                // Failed RPCs and uncertain acknowledgments leave durable work for replay.
                pending = true;
              }
            }
            if (events.length < 100) break;
            afterId = events.at(-1)!.id;
          }
        }
      } catch (error) {
        pending = true; // A failed scan must survive a retry skipped during idle drain.
        throw error;
      }
    },
  });
  function wake() { pending = true; delivery.wake(); }
  const unsubscribeConfig = manager.onConfigApplied(wake);
  lifecycle.on("plugin.loaded", wake);
  lifecycle.on("plugin.enabled", wake);
  lifecycle.on("plugin.worker_started", wake);
  return {
    ...delivery,
    wake,
    dispose() {
      unsubscribeConfig();
      lifecycle.off("plugin.loaded", wake);
      lifecycle.off("plugin.enabled", wake);
      lifecycle.off("plugin.worker_started", wake);
    },
  };
}
