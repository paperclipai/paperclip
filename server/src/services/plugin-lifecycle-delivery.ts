import { projectInstanceSecretService } from "./project-instance-secrets.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { createOwnedDatabaseListener, type OwnedDatabaseListener, agents, companies, pluginCompanySettings, pluginConfig, plugins, projects, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pluginLifecycleInbox } from "./plugin-lifecycle-inbox.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { isWorkspaceProvider } from "./project-workspace-provider.js";
import { managedPluginEnabledCompanies } from "./managed-plugin-worker-env.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { registerIdleLocalWorkProbe, type IdleLocalWork } from "./idle-local-work.js";
import { isIdleTaskDrainActive, subscribeTaskDrainChanges, subscribeTaskDrainExpiry } from "./task-admission.js";

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
  let held = false;
  let epoch = 0;
  let delivering = 0;
  let listenerUpdates = 0;
  let listenerFailure = false;
  let inspectionFailure = false;
  let listenerClient: OwnedDatabaseListener | undefined;
  let disposePromise: Promise<void> | undefined;
  const retryAt = new Map<string, number>();
  const unregisterIdle = registerIdleLocalWorkProbe(() => listenerFailure || inspectionFailure ? "unknown"
    : listenerUpdates || delivering || listenerClient || pending ? "present" : "none");
  const refreshedRuntimeCompanies = new Set<string>();
  const retryMs = 30_000;
  async function managedTargets() {
    const ready = await db.select().from(plugins).where(eq(plugins.status, "ready"));
    const targets = ready.flatMap(plugin => managedPluginEnabledCompanies(plugin.pluginKey).map(companyId => ({ plugin, companyId })));
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
  async function deliverableLifecycleTypes({ plugin, companyId }: Awaited<ReturnType<typeof deliveryTargets>>[number]) {
    const types = plugin.manifestJson.resourceLifecycle;
    if (!types?.length || !plugin.manifestJson.capabilities.includes("events.subscribe")) return;
    const [disabled] = await db.select({ id: pluginCompanySettings.id }).from(pluginCompanySettings)
      .where(and(eq(pluginCompanySettings.pluginId, plugin.id), eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.enabled, false)));
    return disabled ? undefined : types;
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
      delivering++;
      pending = false;
      try {
        await ensureListening();
        for (const [key, at] of retryAt) if (at <= Date.now()) retryAt.delete(key);
        for (const target of await deliveryTargets()) {
          const types = await deliverableLifecycleTypes(target);
          if (!types) continue;
          const { plugin, companyId } = target;
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
                if (event.resourceType === "agent_runtime" && enabled.manifest.capabilities.includes("agents.lifecycle.manage")) {
                  stage = "ownership";
                  const [agent] = await db.select({ requiredPluginIds: agents.lifecycleRequiredPluginIds }).from(agents)
                    .where(and(eq(agents.id, event.resourceId), eq(agents.companyId, companyId)));
                  if (agent && !agent.requiredPluginIds?.includes(plugin.id)) {
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
      } finally { delivering--; }
    },
  });
  function wake() { if (disposed) return; epoch++; pending = true; delivery.wake(); }
  let listening: Awaited<ReturnType<Db["$client"]["listen"]>> | undefined;
  let listenerUpdate = Promise.resolve();
  function updateListener<T>(operation: () => Promise<T>): Promise<T> {
    listenerUpdates++;
    const update = listenerUpdate.then(operation);
    listenerUpdate = update.then(() => undefined, () => undefined);
    return update.finally(() => { listenerUpdates--; });
  }
  async function closeListener() {
    const client = listenerClient;
    if (!client) return;
    try { await client.close(); }
    catch (error) {
      listenerFailure = true;
      try { logger.warn({ operation: "plugin_lifecycle_listener_close", failed: true }, "Owned plugin lifecycle listener close failed"); } catch {}
      throw error;
    }
    if (listenerClient === client) { listening = undefined; listenerClient = undefined; }
    listenerFailure = false;
  }
  function ensureListening() {
    return updateListener(async () => {
      if (disposed || held || isIdleTaskDrainActive()) return;
      let installed: Array<{ manifest: (typeof plugins.$inferSelect)["manifestJson"] }>;
      try {
        const configured = await db.select({ manifest: plugins.manifestJson }).from(plugins)
          .innerJoin(pluginConfig, eq(pluginConfig.pluginId, plugins.id))
          .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, pluginConfig.companyId)))
          .where(and(eq(plugins.status, "ready"), or(isNull(pluginCompanySettings.enabled), eq(pluginCompanySettings.enabled, true))));
        installed = [...configured, ...(await enabledManagedPlugins()).map(plugin => ({ manifest: plugin.manifestJson }))];
        inspectionFailure = false;
      } catch (error) { inspectionFailure = true; throw error; }
      if (disposed || held || isIdleTaskDrainActive()) return;
      const wanted = installed.some(plugin => plugin.manifest.resourceLifecycle?.includes("agent_runtime") && plugin.manifest.capabilities?.includes("events.subscribe"));
      if (!wanted) { await closeListener(); listenerFailure = false; return; }
      if (listenerFailure) await closeListener();
      if (disposed || held || isIdleTaskDrainActive()) return;
      try {
        listenerClient ??= createOwnedDatabaseListener(db);
        listening ??= await listenerClient.listen("paperclip_plugin_lifecycle", wake, wake);
        listenerFailure = false;
      } catch (error) { listenerFailure = true; throw error; }
    });
  }
  async function hasJournalWork(current: () => boolean): Promise<IdleLocalWork> {
    if (!current()) return "unknown";
    const targets = await deliveryTargets();
    if (!current()) return "unknown";
    for (const target of targets) {
      if (!current()) return "unknown";
      const types = await deliverableLifecycleTypes(target);
      if (!current()) return "unknown";
      if (!types) continue;
      const { plugin, companyId } = target;
      const hasEvents = await pluginLifecycleInbox(db, plugin.id).hasPending(companyId, types);
      if (!current()) return "unknown";
      if (hasEvents) { wake(); inspectionFailure = false; return "present"; }
    }
    inspectionFailure = false;
    return "none";
  }
  function pluginChanged() {
    wake();
    void ensureListening().catch(wake);
  }
  const resumeListening = () => {
    if (disposed) return;
    epoch++;
    if (isIdleTaskDrainActive()) return;
    held = false;
    wake();
    void ensureListening().catch(wake);
  };
  const unsubscribeDrain = subscribeTaskDrainChanges(resumeListening);
  const unsubscribeExpiry = subscribeTaskDrainExpiry(resumeListening);
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
    async prepareForIdleSleep({ canRetire }: { canRetire: () => boolean }): Promise<IdleLocalWork> {
      if (disposed || !canRetire() || !isIdleTaskDrainActive() || (listenerFailure && !listenerClient)) return "unknown";
      if (listenerUpdates || delivering || pending) return "present";
      const ownerEpoch = epoch;
      held = true;
      const current = () => !disposed && held && isIdleTaskDrainActive() && canRetire() && epoch === ownerEpoch;
      return updateListener(async () => {
        if (!current()) return "unknown";
        if (listenerUpdates !== 1 || delivering || pending) return "present";
        try {
          const before = await hasJournalWork(current);
          if (before !== "none") return before;
          if (!current() || (listenerFailure && !listenerClient)) return "unknown";
          await closeListener();
          if (!current()) return "unknown";
          if (listenerFailure) return "unknown";
          if (pending || delivering) return "present";
          return await hasJournalWork(current);
        } catch {
          inspectionFailure = true;
          return "unknown";
        }
      });
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      epoch++;
      unsubscribeConfig();
      unsubscribeDrain();
      unsubscribeExpiry();
      lifecycle.off("plugin.loaded", pluginChanged);
      lifecycle.off("plugin.enabled", pluginChanged);
      lifecycle.off("plugin.worker_started", pluginChanged);
      lifecycle.off("plugin.status_changed", pluginChanged);
      lifecycle.off("plugin.disabled", pluginChanged);
      lifecycle.off("plugin.unloaded", pluginChanged);
      disposePromise = (async () => {
        const failures: unknown[] = [];
        try { await delivery.stop(); } catch (error) { failures.push(error); }
        try { await updateListener(closeListener); } catch (error) { failures.push(error); }
        if (failures.length) {
          listenerFailure = true;
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Plugin lifecycle delivery disposal failed");
        }
        unregisterIdle();
      })().catch(error => { disposePromise = undefined; throw error; });
      return disposePromise;
    },
  };
}
