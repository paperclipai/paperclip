import { subscribeDatabaseWork, databaseWorkPending, reconcileDatabaseWork } from "@paperclipai/db";
import { createWorkScheduler } from "./work-scheduler.js";
import { type DeliveryQueue } from "./delivery-work-notifications.js";
import { beginIdleTrackedWork } from "./task-admission.js";

export function createDeliveryWorkCoordinator(input: {
  owner: object;
  canRun: () => boolean;
  // Idle drain may reconcile admitted writes without dispatching new work.
  // Warm standby can disable both operations.
  canReconcile?: () => boolean;
  onError: (error: unknown, queue: DeliveryQueue) => void;
}) {
  const scheduler = createWorkScheduler();
  const workers = new Map<DeliveryQueue, { wake: () => void; stop: () => Promise<void> }>();
  let stopped = false;

  return {
    // Only these registered tasks are represented; not yet the whole instance.
    nextWakeAt: scheduler.nextWakeAt,
    register(queue: DeliveryQueue, task: {
      retryMs: number;
      run: (signal: AbortSignal) => Promise<unknown>;
      hasPending: () => Promise<boolean>;
      // Optional maintenance/retry deadline restored from durable state.
      nextRunAt?: () => number | null;
    }) {
      if (stopped) throw new Error("Delivery coordinator is stopped");
      if (workers.has(queue)) throw new Error(`Delivery worker already registered: ${queue}`);
      let dirty = false;
      let scheduledAt: number | null = null;
      let running: Promise<void> | null = null;
      let workerStopped = false;
      let controller: AbortController | null = null;
      let finishIntent: (() => void) | undefined;
      function schedule(delay: number) {
        if (workerStopped) return;
        const at = Date.now() + delay;
        if (scheduledAt !== null && scheduledAt <= at) return;
        scheduledAt = at;
        scheduler.schedule(queue, at, start);
      }
      function start() {
        if (workerStopped || running) return;
        scheduler.cancel(queue);
        scheduledAt = null;
        if (!input.canRun() && !(input.canReconcile?.() ?? false)) { schedule(task.retryMs); return; }
        dirty = false;
        const finish = beginIdleTrackedWork();
        const attempt = new AbortController();
        controller = attempt;
        running = Promise.resolve().then(() => reconcileDatabaseWork(input.owner, queue))
          .then(() => workerStopped || !input.canRun() ? undefined : task.run(attempt.signal)).then(() => workerStopped ? false : task.hasPending()).then(pending => {
          if (pending || databaseWorkPending(input.owner, queue)) schedule(task.retryMs);
          else { finishIntent?.(); finishIntent = undefined; }
          const next = task.nextRunAt?.();
          if (next != null) schedule(Math.max(0, next - Date.now()));
        }).catch(error => {
          schedule(task.retryMs);
          // Logging must never turn a recoverable sweep failure into an
          // unhandled rejection or prevent other queues from running.
          try { if (!workerStopped) input.onError(error, queue); } catch { /* Recovery remains scheduled. */ }
        }).finally(() => {
          running = null;
          controller = null;
          finish();
          if (dirty) schedule(0);
        });
      }
      function wake() {
        if (workerStopped) return;
        dirty = true;
        if (!running) schedule(0);
      }
      const unsubscribe = subscribeDatabaseWork(input.owner, queue, event => {
        if (workerStopped) return;
        if (databaseWorkPending(input.owner, queue)) {
          finishIntent ??= beginIdleTrackedWork();
          // Give the transaction time to settle. Its settlement notification
          // replaces this deadline with an immediate wake on the normal path.
          if (!running) schedule(task.retryMs);
        }
        if (event === "settled") wake();
      });
      const worker = { wake, async stop() {
        workerStopped = true;
        controller?.abort(new Error("Delivery worker stopped"));
        unsubscribe();
        scheduler.cancel(queue);
        await running;
        finishIntent?.(); finishIntent = undefined;
      } };
      workers.set(queue, worker);
      const ready = Promise.resolve().then(() => { start(); return running; });
      return { ready, wake };
    },
    async stop() {
      stopped = true;
      scheduler.stop();
      await Promise.all(Array.from(workers.values(), worker => worker.stop()));
      workers.clear();
    },
  };
}
