import { randomUUID } from "node:crypto";
import type { LifecycleDriver, LifecycleStore } from "./ports.js";
import { isLifecycleWorkPending } from "../domain/policy.js";

/** Database leases protect each attempt across server processes. */
export function createLifecycleWorker(store: LifecycleStore, driver: LifecycleDriver, canRun = () => true) {
  let stopped = false;
  const active = new Map<string, Promise<void>>();
  let running: Promise<void> | undefined;

  async function process(id: string) {
    phase: for (let step = 0; !stopped && canRun() && step < 8; step++) {
      const owner = randomUUID();
      const agent = await store.claim(id, owner, new Date());
      if (!agent || !isLifecycleWorkPending(agent.lifecycleState)) return;
      const renewal = setInterval(() => {
        void store.renew(agent, owner, new Date()).catch(() => {});
      }, 30_000);
      renewal.unref?.();
      try {
        const operation = agent.lifecycleOperation!;
        const pluginIds = agent.lifecycleRequiredPluginIds ?? await driver.requiredPluginIds(agent);
        if (agent.lifecycleRequiredPluginIds === null && !await store.setRequiredPlugins(agent, owner, pluginIds)) continue;
        if (!canRun()) {
          await store.defer(agent, owner, null, new Date());
          return;
        }
        if (!operation.hostComplete) {
          if (!await store.renew(agent, owner, new Date())) continue;
          if (await driver.runHost(agent) === "pending") {
            if (!await store.defer(agent, owner, null, new Date())) continue;
            return;
          }
          if (!await store.completeHost(agent, owner)) continue;
        }
        for (const pluginId of pluginIds) {
          if (operation.completedPluginIds.includes(pluginId)) continue;
          if (!canRun()) {
            await store.defer(agent, owner, null, new Date());
            return;
          }
          if (!await store.renew(agent, owner, new Date())) continue phase;
          if (await driver.runPlugin(agent, pluginId) === "pending") {
            if (!await store.defer(agent, owner, null, new Date())) continue phase;
            return;
          }
          if (!await store.completePlugin(agent, owner, pluginId)) continue phase;
        }
        const changed = await store.change(id, "complete", { version: agent.lifecycleVersion, owner });
        if (changed && !isLifecycleWorkPending(changed.lifecycleState)) return;
      } catch {
        if (!await store.defer(agent, owner, "The lifecycle step failed. Retry the operation.", new Date())) continue;
        return;
      } finally {
        clearInterval(renewal);
      }
    }
  }

  async function sweep() {
    const pending = await store.pending(100, new Date());
    const entries = pending.values();
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (const id of entries) await start(id);
    }));
  }

  function start(id: string): Promise<void> {
    if (stopped || !canRun()) return Promise.resolve();
    const existing = active.get(id);
    if (existing) return existing;
    const work = process(id).finally(() => { active.delete(id); });
    active.set(id, work);
    return work;
  }

  return {
    process: start,
    async stop() {
      stopped = true;
      await Promise.allSettled([...active.values()]);
    },
    sweep() {
      return running ??= sweep().finally(() => { running = undefined; });
    },
  };
}
