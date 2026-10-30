import { randomUUID } from "node:crypto";
import type { LifecycleDriver, LifecycleStore, LifecycleFailure, LifecycleAgent } from "./ports.js";
import { isLifecycleWorkPending } from "../domain/policy.js";
import { lifecycleFailureMessage } from "./failure.js";

/** Database leases protect each attempt across server processes. */
export function createLifecycleWorker(store: LifecycleStore, driver: LifecycleDriver, reportFailure: (context: LifecycleFailure, error: unknown) => void, canRun = () => true) {
  let stopped = false;
  const active = new Map<string, Promise<void>>();
  // A host stop that never settles (dead run, zombie lease, recycled pid) must not
  // wedge an agent forever: after this bound the worker forces the phase forward.
  const STALL_TIMEOUT_MS = Number(globalThis.process.env.PAPERCLIP_LIFECYCLE_STALL_TIMEOUT_MS ?? 300_000);
  function stalledFor(operation: NonNullable<LifecycleAgent["lifecycleOperation"]>) {
    const started = operation.startedAt ? Date.parse(operation.startedAt) : Number.NaN;
    return Number.isFinite(started) ? Date.now() - started : operation.attempts * 2_000;
  }
  const lifecycleStalled = (operation: NonNullable<LifecycleAgent["lifecycleOperation"]>) =>
    stalledFor(operation) >= STALL_TIMEOUT_MS;
  function warnForced(agent: LifecycleAgent, operation: NonNullable<LifecycleAgent["lifecycleOperation"]>, stage: string, extra: Record<string, unknown> = {}) {
    console.warn(JSON.stringify({ level: 40, msg: "lifecycle watchdog forced completion", stage,
      agentId: agent.id, operationId: operation.id, phase: agent.lifecycleState,
      attempts: operation.attempts, stalledMs: stalledFor(operation), ...extra }));
  }
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
      let failureContext: LifecycleFailure = { ...context, stage: "host" };
      const runStep = <T>(stage: LifecycleFailure["stage"], work: () => Promise<T>, pluginId?: string) => {
        const stepContext = { ...context, stage, ...(pluginId ? { pluginId } : {}) };
        return attempt(stepContext, work).catch(error => { failureContext = stepContext; throw error; });
      };
      const renewal = setInterval(() => {
        void attempt({ ...context, stage: "renew" }, () => store.renew(agent, owner, new Date())).catch(() => {});
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
          const hostResult = await runStep("host", () => driver.runHost(agent));
          if (hostResult === "pending" && !lifecycleStalled(operation)) {
            if (!await runStep("defer", () => store.defer(agent, owner, null, new Date()))) continue;
            return;
          }
          if (hostResult === "pending") warnForced(agent, operation, "host");
          if (!await runStep("complete_host", () => store.completeHost(agent, owner))) continue;
        }
        for (const pluginId of pluginIds) {
          if (operation.completedPluginIds.includes(pluginId)) continue;
          if (!canRun()) {
            await runStep("defer", () => store.defer(agent, owner, null, new Date()));
            return;
          }
          if (!await runStep("renew", () => store.renew(agent, owner, new Date()))) continue phase;
          const pluginResult = await runStep("plugin", () => driver.runPlugin(agent, pluginId), pluginId);
          if (pluginResult === "pending" && !lifecycleStalled(operation)) {
            if (!await runStep("defer", () => store.defer(agent, owner, null, new Date()))) continue phase;
            return;
          }
          if (pluginResult === "pending") warnForced(agent, operation, "plugin", { pluginId });
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
      } catch (error) {
        const message = lifecycleFailureMessage(failureContext, error);
        if (!await runStep("defer", () => store.defer(agent, owner, message, new Date()))) continue;
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
