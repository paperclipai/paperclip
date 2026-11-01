import { subscribeDatabaseWork, databaseWorkPending, reconcileDatabaseWork } from "@paperclipai/db/work-signals";
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
      // Scoped hints belong to the outer transaction, including uncertainty recovery.
      onSettled?: (hints?: ReadonlySet<string>) => void;
      // Optional maintenance/retry deadline restored from durable state.
      nextRunAt?: () => number | null;
      // Opt in only when run has recorded per-item failure backoffs. Other
      // eligible items may already be due, unlike an unchanged failed deadline.
      nextRunAtOnError?: () => number | null;
      // An empty queue's maintenance may wait until dispatch admission reopens.
      // Notifications and unresolved producer writes still reconcile in drain.
      pausePassiveMaintenance?: boolean;
      // Accounting and stop delivery finish already-admitted obligations;
      // they must continue during admission drain, never warm standby.
      runDuringDrain?: boolean;
    }) {
      if (stopped) throw new Error("Delivery coordinator is stopped");
      if (workers.has(queue)) throw new Error(`Delivery worker already registered: ${queue}`);
      let dirty = false;
      let scheduledAt: number | null = null;
      let running: Promise<void> | null = null;
      let workerStopped = false;
      let controller: AbortController | null = null;
      let finishIntent: (() => void) | undefined;
      let pendingWork = true;
      function schedule(delay: number, deadline?: number) {
        if (workerStopped) return;
        const at = deadline ?? Date.now() + delay;
        if (scheduledAt !== null && scheduledAt <= at) return;
        scheduledAt = at;
        scheduler.schedule(queue, at, start);
      }
      function start() {
        if (workerStopped || running) return;
        scheduler.cancel(queue);
        scheduledAt = null;
        if (!input.canRun() && !(input.canReconcile?.() ?? false)) { schedule(task.retryMs); return; }
        if (!input.canRun() && task.pausePassiveMaintenance && !pendingWork && !dirty &&
            !finishIntent && !databaseWorkPending(input.owner, queue)) {
          // A timer alone must not change the idle generation during a slow
          // backup. Retry without querying or admitting work; a notification
          // still preempts this deadline and retains its normal intent hold.
          schedule(task.retryMs);
          return;
        }
        dirty = false;
        const finish = beginIdleTrackedWork();
        const attempt = new AbortController();
        let runFailed = false;
        controller = attempt;
        running = Promise.resolve().then(() => reconcileDatabaseWork(input.owner, queue))
          .then(() => workerStopped || !(input.canRun() || (task.runDuringDrain && input.canReconcile?.())) ? undefined : task.run(attempt.signal).catch(error => { runFailed = true; throw error; })).then(() => workerStopped ? false : task.hasPending()).then(pending => {
          pendingWork = pending || databaseWorkPending(input.owner, queue);
          if (pendingWork) schedule(task.retryMs);
          else { finishIntent?.(); finishIntent = undefined; }
          const next = task.nextRunAt?.();
          if (next != null) {
            const delay = Math.max(0, next - Date.now());
            schedule(delay === 0 && !input.canRun() ? task.retryMs : delay, delay > 0 ? next : undefined);
          }
        }).catch(error => {
          schedule(task.retryMs);
          let failure = error;
          try {
            const scopedRetry = runFailed && task.nextRunAtOnError;
            const next = input.canRun() ? (scopedRetry ? scopedRetry() : task.nextRunAt?.()) : null;
            if (next != null && (scopedRetry || next > Date.now())) schedule(0, Math.max(Date.now(), next));
          } catch (deadlineError) {
            failure = new AggregateError([error, deadlineError], "Delivery failure deadline could not be read");
          }
          // Logging must never turn a recoverable sweep failure into an
          // unhandled rejection or prevent other queues from running.
          try { if (!workerStopped) input.onError(failure, queue); } catch { /* Recovery remains scheduled. */ }
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
      const unsubscribe = subscribeDatabaseWork(input.owner, queue, (event, hints) => {
        if (workerStopped) return;
        if (databaseWorkPending(input.owner, queue)) {
          finishIntent ??= beginIdleTrackedWork();
          // Give the transaction time to settle. Its settlement notification
          // replaces this deadline with an immediate wake on the normal path.
          if (!running) schedule(task.retryMs);
        }
        if (event === "settled") { task.onSettled?.(hints); wake(); }
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
      return { ready, ...worker };
    },
    // Stop dispatch queues first, keeping only already-admitted controller
    // commands alive until their execution owners finish the handoff. A later
    // stop() closes the retained workers and the shared scheduler as well.
    async stop(keepQueues?: ReadonlySet<DeliveryQueue>) {
      stopped = true;
      if (!keepQueues?.size) scheduler.stop();
      await Promise.all(Array.from(workers, async ([queue, worker]) => {
        if (keepQueues?.has(queue)) return;
        await worker.stop();
        workers.delete(queue);
      }));
    },
  };
}
