import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

// Tracks agentIds whose withAgentStartLock() call is currently executing somewhere up the
// current async call chain. A call that re-enters the lock for the same agent from within
// its own execution (e.g. claimQueuedRun -> cancelRunInternal -> releaseIssueExecutionAndPromote
// -> startNextQueuedRunForAgent for the same agent, see RENA-55149) is not a concurrent start
// attempt -- it runs inline instead of waiting on the lock it is already holding, which would
// otherwise stall for AGENT_START_LOCK_STALE_MS before the staleness fallback releases it.
const activeAgentIds = new AsyncLocalStorage<ReadonlySet<string>>();

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

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  if (activeAgentIds.getStore()?.has(agentId)) {
    return fn();
  }

  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const nextActive = new Set(activeAgentIds.getStore());
  nextActive.add(agentId);
  const run = waitForPrevious.then(() => activeAgentIds.run(nextActive, fn));
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
