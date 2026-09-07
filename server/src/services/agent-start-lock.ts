import { logger } from "../middleware/logger.js";

const START_LOCK_STALE_MS = 30_000;
const startLocksByKey = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForStartLock(
  logContext: Record<string, unknown>,
  lock: { promise: Promise<void>; startedAtMs: number },
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ ...logContext, staleMs: elapsedMs }, "start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ ...logContext, staleMs: START_LOCK_STALE_MS }, "start lock timed out; continuing queued-run start");
  }
}

// In-process, promise-chain mutex keyed by an arbitrary string. Safe because
// heartbeat dispatch runs inside a single Node process (see GRO-60) — this is
// not a distributed lock and must not be relied on across processes.
async function withKeyedStartLock<T>(key: string, logContext: Record<string, unknown>, fn: () => Promise<T>) {
  const previous = startLocksByKey.get(key);
  const waitForPrevious = previous ? waitForStartLock(logContext, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByKey.set(key, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByKey.get(key)?.promise === marker) {
      startLocksByKey.delete(key);
    }
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  return withKeyedStartLock(`agent:${agentId}`, { agentId }, fn);
}

// Serializes the company-wide slot check + claim against every other agent's
// dispatch decision in the same company, so two agents can't both read a
// stale running count and jointly overshoot companies.maxConcurrentAgentRuns.
export async function withCompanyRunDispatchLock<T>(companyId: string, fn: () => Promise<T>) {
  return withKeyedStartLock(`company:${companyId}`, { companyId }, fn);
}
