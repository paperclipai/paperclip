import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

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

/**
 * RBR-974: instance-wide serialization for the run-admission critical section.
 *
 * withAgentStartLock only serializes starts for a single agent, so two different
 * agents could each read "4 of 5 global slots used" and each start a run,
 * overshooting the instance ceiling. The global ceiling is only a ceiling if the
 * read-count-then-claim sequence is atomic across agents.
 *
 * The guarded section is short — count queued runs, claim rows, dispatch
 * fire-and-forget — so serializing it does not serialize the runs themselves.
 */
let globalAdmissionLock: Promise<void> = Promise.resolve();

export async function withGlobalAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalAdmissionLock;
  let release: () => void = () => {};
  globalAdmissionLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Never let a rejected predecessor wedge the queue for everyone behind it.
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

