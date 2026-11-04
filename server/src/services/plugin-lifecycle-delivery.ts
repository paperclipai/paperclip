import { projectInstanceSecretService } from "./project-instance-secrets.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { companies, pluginCompanySettings, pluginConfig, plugins, projects, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pluginLifecycleInbox } from "./plugin-lifecycle-inbox.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { isWorkspaceProvider } from "./project-workspace-provider.js";
import { managedPluginEnabledCompanies } from "./managed-plugin-worker-env.js";
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
  let disposed = false;
  const retryAt = new Map<string, number>();
  const refreshedRuntimeCompanies = new Set<string>();
  const retryMs = 30_000;
  async function managedTargets() {
    const ready = await db.select().from(plugins).where(eq(plugins.status, "ready"));
    const targets = ready.flatMap(plugin => managedPluginEnabledCompanies(plugin).map(companyId => ({ plugin, companyId })));
    if (!targets.length) return targets;
    const existing = await db.select({ id: companies.id }).from(companies)
      .where(inArray(companies.id, targets.map(target => target.companyId)));
    const existingIds = new Set(existing.map(company => company.id));
    return targets.filter(target => existingIds.has(target.companyId));
  }
  async function enabledManagedPlugins() {
    const targets = await managedTargets();
    if (!targets.length) return [];
    const disabled = await db.select({ pluginId: pluginCompanySettings.pluginId, companyId: pluginCompanySettings.companyId }).from(pluginCompanySettings)
      .where(and(inArray(pluginCompanySettings.pluginId, targets.map(target => target.plugin.id)), eq(pluginCompanySettings.enabled, false)));
    const disabledKeys = new Set(disabled.map(row => `${row.pluginId}:${row.companyId}`));
    return targets.filter(target => !disabledKeys.has(`${target.plugin.id}:${target.companyId}`)).map(target => target.plugin);
  }
  async function deliveryTargets() {
    const configured = await db.select({ plugin: plugins, companyId: pluginConfig.companyId })
      .from(plugins).innerJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
      .where(eq(plugins.status, "ready"))
      .orderBy(asc(plugins.installOrder), asc(pluginConfig.companyId));
    const managed = await managedTargets();
    if (!managed.length) return configured;
    const seen = new Set(configured.map(target => `${target.plugin.id}:${target.companyId}`));
    return [...configured, ...managed.filter(target => !seen.has(`${target.plugin.id}:${target.companyId}`))].sort((a, b) =>
      (a.plugin.installOrder ?? Infinity) - (b.plugin.installOrder ?? Infinity) || a.companyId.localeCompare(b.companyId));
  }
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
        await ensureListening();
        for (const [key, at] of retryAt) if (at <= Date.now()) retryAt.delete(key);
        for (const { plugin, companyId } of await deliveryTargets()) {
          const types = plugin.manifestJson.resourceLifecycle;
          if (!types?.length || !plugin.manifestJson.capabilities.includes("events.subscribe")) continue;
          const [disabled] = await db.select({ id: pluginCompanySettings.id }).from(pluginCompanySettings)
            .where(and(eq(pluginCompanySettings.pluginId, plugin.id), eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.enabled, false)));
          if (disabled) continue;
          if (types.includes("agent_runtime") && !refreshedRuntimeCompanies.has(companyId)) {
            await db.execute(sql`SELECT paperclip_invalidate_company_agent_runtimes(${companyId}::uuid)`);
            refreshedRuntimeCompanies.add(companyId);
          }
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
                if (event.resourceType === "project" && isWorkspaceProvider(enabled.manifest)) {
                  stage = "ownership";
                  const [project] = await db.select({ policy: projects.executionWorkspacePolicy }).from(projects)
                    .where(and(eq(projects.id, event.resourceId), eq(projects.companyId, companyId)));
                  if (project && parseProjectExecutionWorkspacePolicy(project.policy)?.storageProviderPluginId !== plugin.id) {
                    await inbox.acknowledge(companyId, event.id);
                    wake();
                    continue;
                  }
                }
                stage = "credentials";
                const credentials = event.resourceType === "project" && enabled.manifest.capabilities.includes("projects.instance-secrets")
                  ? await projectInstanceSecretService(db, plugin.id).prepare(event) : undefined;
                stage = "callback";
                const result = await manager.call(plugin.id, "resourceLifecycle", credentials ? { ...event, instanceSecrets: credentials.instanceSecrets } : event, 30_000);
                stage = "result";
                if (result?.eventId !== event.id || !["acknowledged", "retry", "deferred"].includes(result.status)) {
                  throw new Error("Invalid resource lifecycle result");
                }
                if (signal.aborted) return;
                if (result.status === "acknowledged") {
                  stage = "acknowledgment";
                  if (result.instanceSecrets !== undefined && !credentials) throw new Error("Project instance secrets outside callback scope");
                  await inbox.acknowledge(companyId, event.id, credentials ? { snapshot: credentials.snapshot, changes: result.instanceSecrets ?? {} } : undefined);
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
  function wake() { if (disposed) return; pending = true; delivery.wake(); }
  let listening: Awaited<ReturnType<Db["$client"]["listen"]>> | undefined;
  let listenerUpdate = Promise.resolve();
  function ensureListening() {
    const update = listenerUpdate.then(async () => {
      if (disposed || !db.$client?.listen) return;
      const configured = await db.select({ manifest: plugins.manifestJson }).from(plugins)
        .innerJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
        .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, pluginConfig.companyId)))
        .where(and(eq(plugins.status, "ready"), or(isNull(pluginCompanySettings.enabled), eq(pluginCompanySettings.enabled, true))));
      const installed = [...configured, ...(await enabledManagedPlugins()).map(plugin => ({ manifest: plugin.manifestJson }))];
      if (disposed) return;
      const wanted = installed.some(plugin => plugin.manifest.resourceLifecycle?.includes("agent_runtime") && plugin.manifest.capabilities?.includes("events.subscribe"));
      if (wanted) listening ??= await db.$client.listen("paperclip_plugin_lifecycle", wake, wake);
      else if (listening) {
        const subscription = listening;
        listening = undefined;
        await subscription.unlisten();
      }
    });
    listenerUpdate = update.catch(() => {});
    return update;
  }
  function pluginChanged() {
    wake();
    void ensureListening().catch(wake);
  }
  const listenerReady = ensureListening();
  const unsubscribeConfig = manager.onConfigApplied(pluginChanged);
  lifecycle.on("plugin.loaded", pluginChanged);
  lifecycle.on("plugin.enabled", pluginChanged);
  lifecycle.on("plugin.worker_started", pluginChanged);
  lifecycle.on("plugin.status_changed", pluginChanged);
  lifecycle.on("plugin.disabled", pluginChanged);
  lifecycle.on("plugin.unloaded", pluginChanged);
  return {
    ...delivery,
    ready: listenerReady,
    wake,
    dispose() {
      disposed = true;
      void listenerUpdate.then(() => listening?.unlisten()).catch(() => {});
      unsubscribeConfig();
      lifecycle.off("plugin.loaded", pluginChanged);
      lifecycle.off("plugin.enabled", pluginChanged);
      lifecycle.off("plugin.worker_started", pluginChanged);
      lifecycle.off("plugin.status_changed", pluginChanged);
      lifecycle.off("plugin.disabled", pluginChanged);
      lifecycle.off("plugin.unloaded", pluginChanged);
    },
  };
}
