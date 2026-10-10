import { randomUUID } from "node:crypto";
import type { LifecycleDriver, LifecycleStore, LifecycleFailure } from "./ports.js";
import { isLifecycleWorkPending } from "../domain/policy.js";

/** Database leases protect each attempt across server processes. */
export function createLifecycleWorker(store: LifecycleStore, driver: LifecycleDriver, reportFailure: (context: LifecycleFailure, error: unknown) => void, canRun = () => true) {
  let stopped = false;
  const active = new Map<string, Promise<void>>();
  let running: Promise<void> | undefined;

  async function attempt<T>(context: LifecycleFailure, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { reportFailure(context, error); throw error; }
  }

  async function process(id: string) {
    phase: for (let step = 0; !stopped && canRun() && step < 8; step++) {
      const owner = randomUUID();
      const agent = await attempt({ stage: "claim", agentId: id }, () => store.claim(id, owner, new Date()));
      if (!agent || !isLifecycleWorkPending(agent.lifecycleState)) return;
      const context = { agentId: agent.id, companyId: agent.companyId, phase: agent.lifecycleState,
        operationId: agent.lifecycleOperation?.id, version: agent.lifecycleVersion };
      const runStep = <T>(stage: LifecycleFailure["stage"], work: () => Promise<T>, pluginId?: string) =>
        attempt({ ...context, stage, ...(pluginId ? { pluginId } : {}) }, work);
      const renewal = setInterval(() => {
        void runStep("renew", () => store.renew(agent, owner, new Date())).catch(() => {});
      }, 30_000);
      renewal.unref?.();
      try {
        const operation = agent.lifecycleOperation!;
        const pluginIds = agent.lifecycleRequiredPluginIds ?? await runStep("select_plugins", () => driver.requiredPluginIds(agent));
        if (agent.lifecycleRequiredPluginIds === null && !await runStep("save_plugins", () => store.setRequiredPlugins(agent, owner, pluginIds))) continue;
        if (!canRun()) {
          await runStep("defer", () => store.defer(agent, owner, null, new Date()));
          return;
        }
        if (!operation.hostComplete) {
          if (!await runStep("renew", () => store.renew(agent, owner, new Date()))) continue;
          if (await runStep("host", () => driver.runHost(agent)) === "pending") {
            if (!await runStep("defer", () => store.defer(agent, owner, null, new Date()))) continue;
            return;
          }
          if (!await runStep("complete_host", () => store.completeHost(agent, owner))) continue;
        }
        for (const pluginId of pluginIds) {
          if (operation.completedPluginIds.includes(pluginId)) continue;
          if (!canRun()) {
            await runStep("defer", () => store.defer(agent, owner, null, new Date()));
            return;
          }
          if (!await runStep("renew", () => store.renew(agent, owner, new Date()))) continue phase;
          if (await runStep("plugin", () => driver.runPlugin(agent, pluginId), pluginId) === "pending") {
            if (!await runStep("defer", () => store.defer(agent, owner, null, new Date()))) continue phase;
            return;
          }
          if (!await runStep("complete_plugin", () => store.completePlugin(agent, owner, pluginId), pluginId)) continue phase;
        }
        const changed = await runStep("transition", () => store.change(id, "complete", { version: agent.lifecycleVersion, owner }));
        if (changed?.lifecycleState === "ready" && !stopped && canRun()) {
          // Accepted messages may already be waiting for verification. Do not
          // leave them until the periodic queue sweep. Readiness is committed;
          // a dispatch failure must not replay setup or defer the old phase.
          await attempt({ ...context, stage: "ready", phase: changed.lifecycleState,
            version: changed.lifecycleVersion, operationId: changed.lifecycleOperation?.id },
          async () => { await driver.onReady?.(changed); }).catch(() => {});
        }
        if (changed && !isLifecycleWorkPending(changed.lifecycleState)) return;
      } catch {
        if (!await runStep("defer", () => store.defer(agent, owner, "The lifecycle step failed. Retry the operation.", new Date()))) continue;
        return;
      } finally {
        clearInterval(renewal);
      }
    }
  }

  async function sweep() {
    const pending = await attempt({ stage: "scan" }, () => store.pending(100, new Date()));
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
