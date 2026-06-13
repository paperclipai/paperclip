import { logger } from "../middleware/logger.js";

// In-process lock keyed on companyId to serialize the claude_local admission
// gate (PAPERCLIP_MAX_CLAUDE_LOCAL_INFLIGHT) check against itself.
//
// Without this, multiple agents in the same company concurrently calling
// startNextQueuedRunForAgent each read inflight=N (where N < cap), each pass
// the gate, and the cap is silently breached. Manifests at pod startup when
// a queue of pending wakeups drains in parallel.
//
// Why per-company and not global: tenants are isolated. Carrie's admission
// shouldn't block Fourslide LLC's, and vice versa. The cap is also per
// company (counted within countRunningClaudeLocalRunsForCompany).
//
// Why in-process and not pg_advisory_lock: Paperclip runs a single replica
// per tenant. If that ever changes, switch to pg_advisory_lock keyed on
// hashtext('claude_local:' || companyId).
//
// Stale-timeout mirrors withAgentStartLock to keep behavior consistent —
// no caller should ever block longer than 30s on this lock.

const ADMISSION_LOCK_STALE_MS = 30_000;
const locksByCompany = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAdmissionLock(
  companyId: string,
  lock: { promise: Promise<void>; startedAtMs: number },
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = ADMISSION_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ companyId, staleMs: elapsedMs }, "claude_local admission lock stale; continuing");
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
    logger.warn({ companyId, staleMs: ADMISSION_LOCK_STALE_MS }, "claude_local admission lock timed out; continuing");
  }
}

export async function withClaudeLocalAdmissionLock<T>(companyId: string, fn: () => Promise<T>) {
  const previous = locksByCompany.get(companyId);
  const waitForPrevious = previous ? waitForAdmissionLock(companyId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  locksByCompany.set(companyId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (locksByCompany.get(companyId)?.promise === marker) {
      locksByCompany.delete(companyId);
    }
  }
}
