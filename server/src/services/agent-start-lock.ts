import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();
// Agents that already have one start attempt waiting behind the current lock
// holder. Only ONE attempt may wait per agent: the waiter preserves liveness
// (it proceeds after the stale window even if the holder is hung), while every
// further attempt skips instead of stacking. Without this gate, start attempts
// arriving every few seconds each fire after their own stale window, piling
// unbounded concurrent claim+spawn sequences onto an already-degraded process
// (#9360).
const pendingStartWaiters = new Set<string>();

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
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T | undefined> {
  const previous = startLocksByAgent.get(agentId);
  if (previous) {
    if (pendingStartWaiters.has(agentId)) {
      // One attempt is already waiting behind the holder. Do not stack another:
      // skip without claiming anything — the scheduler retries on its next pass.
      logger.warn(
        { agentId },
        "agent start lock already has a waiting start attempt; skipping this queued-run start",
      );
      return undefined;
    }
    pendingStartWaiters.add(agentId);
  }
  const waitForPrevious = previous
    ? waitForAgentStartLock(agentId, previous).finally(() => pendingStartWaiters.delete(agentId))
    : Promise.resolve();
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
