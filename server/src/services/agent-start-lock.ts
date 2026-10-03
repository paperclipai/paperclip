import { logger } from "../middleware/logger.js";

export const AGENT_START_LOCK_STALE_MS = 30_000;

type StartLock = { promise: Promise<void>; renewedAtMs: number };

const startLocksByAgent = new Map<string, StartLock>();

// Wait for the incumbent start, but only for as long as its lease is being
// renewed. A holder that calls renew() at each phase boundary keeps the lease
// alive however slow the start is, so a queued run never starts behind it. A
// holder that stops renewing for a full lease window is hung, and the queued
// run proceeds (AUT-5348).
async function waitForAgentStartLock(agentId: string, lock: StartLock) {
  for (;;) {
    const remainingMs = AGENT_START_LOCK_STALE_MS - (Date.now() - lock.renewedAtMs);
    if (remainingMs <= 0) {
      logger.warn({ agentId, staleMs: Date.now() - lock.renewedAtMs }, "agent start lock stale; continuing queued-run start");
      return;
    }

    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      lock.promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          expired = true;
          resolve();
        }, remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!expired) return;
    // Lease window elapsed: the holder may have renewed since we computed
    // remainingMs, so re-check before declaring it stale.
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: (lease: { renew: () => void }) => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const holder: StartLock = { promise: Promise.resolve(), renewedAtMs: Date.now() };
  const renew = () => void (holder.renewedAtMs = Date.now());
  // A queued caller publishes its own entry, so a later caller reads this
  // holder's lease and can start behind the incumbent if it looks stale. Renew
  // while queued; the interval ends the moment this caller acquires.
  const queued = setInterval(renew, Math.ceil(AGENT_START_LOCK_STALE_MS / 2));
  queued.unref?.();
  const run = waitForPrevious.then(() => {
    clearInterval(queued);
    // The lease can be up to half a window old from the queued interval, and
    // the first phase can take longer than what is left of the window.
    renew();
    return fn({ renew });
  });
  holder.promise = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, holder);
  try {
    return await run;
  } finally {
    clearInterval(queued);
    if (startLocksByAgent.get(agentId) === holder) {
      startLocksByAgent.delete(agentId);
    }
  }
}
