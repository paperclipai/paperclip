/**
 * Minimal bounded-concurrency limiter.
 *
 * React Query dedupes identical query keys, but a page that renders many
 * *distinct* keys at once still opens one request per key. Routing those
 * fetches through a limiter keeps a single render from saturating the
 * browser's connection pool and the server's event loop.
 */
export interface ConcurrencyLimiter {
  /** Run `task` once a slot frees up; resolves/rejects with the task. */
  <T>(task: () => Promise<T>): Promise<T>;
}

export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }

  const queue: Array<() => void> = [];
  let active = 0;

  function release() {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        let settled: Promise<T>;
        try {
          settled = task();
        } catch (error) {
          release();
          reject(error);
          return;
        }
        settled.then(resolve, reject).finally(release);
      };

      if (active < maxConcurrent) start();
      else queue.push(start);
    });
  };
}
