// A direction-agnostic scheduler for file-sync operations. Both sync directions
// share this one function. The scheduler starts operation tasks under a bound,
// keeps serial order when concurrency is off, and settles every started task
// before it returns. It stays pure: it imports no runtime or provider module.

// The maximum number of active sync operations when concurrency is on. A caller
// passes this as the bound. Four keeps a useful parallel width without a burst
// of open file handles.
export const SYNC_OPERATION_CONCURRENCY_LIMIT = 4;

// A sync operation. The scheduler calls the thunk to start the operation, so the
// scheduler controls the exact start time and can hold the bound.
export type SyncOperationTask<T> = () => Promise<T>;

// Resolve the number of active tasks the scheduler allows.
// Serial mode allows one active task. Concurrent mode allows the bound, with a
// floor of one so a bad bound never stalls the scheduler.
function resolveActiveLimit(concurrent: boolean, bound: number): number {
  if (!concurrent) {
    return 1;
  }
  const flooredBound = Math.floor(bound);
  if (!Number.isFinite(flooredBound) || flooredBound < 1) {
    return 1;
  }
  return flooredBound;
}

/**
 * Run an ordered list of sync operation tasks and settle every started task.
 *
 * When `concurrent` is false, the scheduler runs the tasks one at a time in
 * input order. When `concurrent` is true, the scheduler keeps at most `bound`
 * tasks active. The scheduler always waits for every started task to settle
 * before it returns. It returns the settled results in input order.
 *
 * @param tasks Ordered task list. The scheduler calls each thunk to start it.
 * @param concurrent Turn concurrency on or off.
 * @param bound Maximum active tasks when `concurrent` is true.
 * @returns Settled results in input order, one per task.
 */
export async function scheduleSyncOperations<T>(
  tasks: ReadonlyArray<SyncOperationTask<T>>,
  concurrent: boolean,
  bound: number = SYNC_OPERATION_CONCURRENCY_LIMIT,
): Promise<Array<PromiseSettledResult<T>>> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  const activeLimit = resolveActiveLimit(concurrent, bound);

  // A shared cursor over the input list. Each worker takes the next task in
  // input order. The cursor keeps serial order and holds the active bound.
  let nextIndex = 0;

  // One worker settles tasks until the list is empty. A worker catches its own
  // task rejection, so a rejection never stops the other workers and never
  // rejects the scheduler. This guarantees settle-all.
  async function runWorker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        const value = await tasks[currentIndex]();
        results[currentIndex] = { status: "fulfilled", value };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  // Start at most `activeLimit` workers, and never more than the task count.
  const workerCount = Math.min(activeLimit, tasks.length);
  const workers: Array<Promise<void>> = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  return results;
}
