import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByKey = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForStartLock(key: string, scope: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ [scope]: key, staleMs: elapsedMs }, "queued-run start lock stale; continuing queued-run start");
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
    logger.warn({ [scope]: key, staleMs: AGENT_START_LOCK_STALE_MS }, "queued-run start lock timed out; continuing queued-run start");
  }
}

async function withStartLock<T>(key: string, scope: string, fn: () => Promise<T>) {
  const previous = startLocksByKey.get(key);
  const waitForPrevious = previous ? waitForStartLock(key, scope, previous) : Promise.resolve();
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
  return withStartLock(`agent:${agentId}`, "agentId", fn);
}

// A fleet-wide run cap makes dispatch contention company-wide: two agents in one
// company must not both read "one slot left" and both claim a run. The per-agent
// lock cannot order them because it is keyed by agent.
//
// ponytail: in-process only, so a second server process can still overshoot the
// cap by one batch. Move the count and the claim onto
// `pg_advisory_xact_lock(hashtextextended(\`fleet:${companyId}\`, 0))` once
// claimQueuedRun accepts a transaction handle.
export async function withCompanyStartLock<T>(companyId: string, fn: () => Promise<T>) {
  return withStartLock(`company:${companyId}`, "companyId", fn);
}
