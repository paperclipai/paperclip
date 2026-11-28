import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "./execution-control-work.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { reconcileRetainedWorkspaces, type PassiveSweep } from "./workspace-recovery.js";

export function registerWorkspaceRecoveryWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  runtime: EnvironmentRuntimeService, onRecovered: Parameters<typeof reconcileRetainedWorkspaces>[2],
  canRun: () => boolean = () => true) {
  const pending = new Set<Promise<void>>();
  let stopped = false;
  let scan: Promise<void> | undefined;
  let wakeWhileBusy = false;
  const passiveSweep: PassiveSweep = {};
  const schedule = executionControlSchedule(db);
  const worker = registerExecutionControlWork(coordinator, [{
    queue: DELIVERY_QUEUES.workspaceRecovery,
    onSettled: () => { passiveSweep.restart = true; if (pending.size >= 2) wakeWhileBusy = true; },
    run: () => scan = (async () => {
      const sweep = passiveSweep, cursor = sweep.cursor;
      const work = await reconcileRetainedWorkspaces(db, runtime, onRecovered, true, continueSweep => {
        if (!stopped && (continueSweep || wakeWhileBusy)) { wakeWhileBusy = false; worker.wake(); }
      }, sweep);
      if (sweep.restart && !sweep.complete && sweep.cursor !== cursor && !stopped) worker.wake();
      for (const job of work ?? []) {
        pending.add(job);
        const settled = () => { pending.delete(job); };
        void job.then(settled, settled);
      }
    })(),
    next: () => pending.size >= 2 ? Promise.resolve(null) : schedule.workspaceRecovery(),
  }], () => !stopped && canRun());
  return { ready: worker.ready, async stop() {
    stopped = true;
    await scan?.catch(() => {});
    await Promise.all(pending);
  } };
}
