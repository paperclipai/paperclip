import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

// Circuit breaker: track lock timeout events in a sliding 60-second window.
// When the rate exceeds the threshold, trigger graceful restart via SIGTERM so
// the drain path (Change 1) can clean up in-flight runs before the process exits.
const LOCK_TIMEOUT_CB_WINDOW_MS = 60_000;
const LOCK_TIMEOUT_CB_THRESHOLD = 10;
const lockTimeoutEvents: number[] = [];

let gracefulRestartScheduled = false;

function recordLockTimeout(agentId: string): void {
  const now = Date.now();
  const windowStart = now - LOCK_TIMEOUT_CB_WINDOW_MS;
  // Evict expired entries from the sliding window.
  while (lockTimeoutEvents.length > 0 && lockTimeoutEvents[0]! < windowStart) {
    lockTimeoutEvents.shift();
  }
  lockTimeoutEvents.push(now);

  logger.warn(
    { agentId, recentTimeouts: lockTimeoutEvents.length, threshold: LOCK_TIMEOUT_CB_THRESHOLD },
    "agent start lock timeout recorded",
  );

  if (lockTimeoutEvents.length >= LOCK_TIMEOUT_CB_THRESHOLD && !gracefulRestartScheduled) {
    gracefulRestartScheduled = true;
    logger.error(
      { recentTimeouts: lockTimeoutEvents.length, windowMs: LOCK_TIMEOUT_CB_WINDOW_MS },
      "agent start lock timeout rate exceeded circuit-breaker threshold — scheduling graceful restart",
    );
    // Defer the SIGTERM slightly so the current call stack can unwind.
    setImmediate(() => {
      process.kill(process.pid, "SIGTERM");
    });
  }
}

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
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
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
    recordLockTimeout(agentId);
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

/** Reset circuit-breaker state between tests. */
export function _resetCircuitBreakerForTesting(): void {
  lockTimeoutEvents.length = 0;
  gracefulRestartScheduled = false;
}
