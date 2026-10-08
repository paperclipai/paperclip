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
        const participants = operation.participants.length ? operation.participants : await driver.participants(agent);
        if (!operation.participants.length && !await store.setParticipants(agent, owner, participants)) continue;
        for (const participant of participants) {
          if (operation.completed.includes(participant)) continue;
          if (!canRun()) {
            await store.recordResult(agent, owner, "", null, new Date());
            return;
          }
          if (!await store.renew(agent, owner, new Date())) continue phase;
          try {
            const result = await driver.run(agent, participant);
            if (result === "pending") {
              if (!await store.recordResult(agent, owner, "", null, new Date())) continue phase;
              return;
            }
            if (!await store.recordResult(agent, owner, participant, null, new Date())) continue phase;
          } catch {
            if (!await store.recordResult(agent, owner, participant, "The lifecycle step failed. Retry the operation.", new Date())) continue phase;
            return;
          }
        }
        const changed = await store.change(id, "complete", { version: agent.lifecycleVersion, owner });
        if (changed && !isLifecycleWorkPending(changed.lifecycleState)) return;
      } catch {
        await store.recordResult(agent, owner, "", "The lifecycle step failed. Retry the operation.", new Date());
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
