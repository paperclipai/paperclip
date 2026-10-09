export class ToolDiscoveryBusyError extends Error {
  constructor() {
    super("Tool discovery is busy. Retry shortly.");
    this.name = "ToolDiscoveryBusyError";
  }
}

/** Limits whole listings, including catalog reads, across gateway service instances. */
export function createToolDiscoveryScheduler(concurrency = 2, queueLimit = 32) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(queueLimit) || queueLimit < 0) {
    throw new Error("Invalid tool discovery scheduler limits");
  }
  let active = 0;
  const queue: Array<{ start: () => void }> = [];
  function drain() {
    while (active < concurrency && queue.length > 0) {
      active += 1;
      queue.shift()!.start();
    }
  }
  function run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active >= concurrency && queue.length >= queueLimit) {
      return Promise.reject(new ToolDiscoveryBusyError());
    }
    return new Promise<T>((resolve, reject) => {
      const job = {
        start() {
          signal?.removeEventListener("abort", abort);
          // Do not free a slot on abort until already-started reads settle.
          Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return work();
          }).then(resolve, reject).finally(() => {
            active -= 1;
            drain();
          });
        },
      };
      function abort() {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(signal!.reason);
      }
      queue.push(job);
      signal?.addEventListener("abort", abort, { once: true });
      drain();
    });
  }
  return { run };
}

export const toolDiscoveryScheduler = createToolDiscoveryScheduler();
