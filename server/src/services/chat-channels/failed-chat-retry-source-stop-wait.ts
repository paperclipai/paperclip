import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { FailedChatRunRetryAuthorizationError } from "../durable-chat-wakeup.js";
import { readStopOnlyCleanup } from "../sandbox-stop-and-retain.js";

/** Long enough for workspace recovery to save files and stop the sandbox again. */
export const FAILED_CHAT_RETRY_SOURCE_STOP_WAIT_MS = 3 * 60_000;
export const FAILED_CHAT_RETRY_SOURCE_STOP_POLL_MS = 5_000;

/** The containment refusal carries no reason. Reasoned refusals (an accepted
 * result, a prior publication or interaction, source authorization) and a
 * mismatched retry selector do not change while a sandbox stops. */
function isSourceContainmentRefusal(error: unknown) {
  if (!(error instanceof HttpError) || error instanceof FailedChatRunRetryAuthorizationError ||
      error.status !== 409) return false;
  const details = error.details as Record<string, unknown> | undefined;
  return details?.code === "chat_failed_run_retry_not_authorized" && details.reason === undefined;
}

/** A stop of the failed run's sandbox is in progress. Workspace recovery holds
 * one while it restarts the sandbox to save its files, and removes the stop
 * receipt until it stops it again. This only permits a wait: containment is
 * still decided by the unchanged retry authority on each attempt. */
export async function failedChatRetrySourceStopPending(db: Db, companyId: string, sourceRunId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, sourceRunId),
  ));
  return leases.some(lease => lease.provider !== "local" && lease.status === "pending_cleanup" &&
    readStopOnlyCleanup(lease) !== null);
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Re-run an exact chat replay's authorization while the failed run's sandbox
 * stop settles, instead of failing the replay on a transient missing receipt.
 * The wait is bounded and stops with the run; the last refusal is returned.
 * The pending stop is read before and after each refused attempt. A stop can
 * settle after the refused transaction releases its locks, so a stop seen
 * before the attempt earns one more attempt even when it is gone after. A
 * refusal with no pending stop on either side is returned at once. */
export async function awaitFailedChatRetrySourceStop<T>(db: Db, input: {
  companyId: string;
  sourceRunId: string | null;
  signal: AbortSignal;
  onWait?: () => Promise<void> | void;
  timeoutMs?: number;
  pollMs?: number;
}, attempt: () => Promise<T>): Promise<T> {
  const sourceRunId = input.sourceRunId;
  if (!sourceRunId) return attempt();
  const deadline = Date.now() + (input.timeoutMs ?? FAILED_CHAT_RETRY_SOURCE_STOP_WAIT_MS);
  let announced = false;
  let settledRetry = false;
  for (;;) {
    const pendingBefore = await failedChatRetrySourceStopPending(db, input.companyId, sourceRunId);
    let pendingAfter: boolean;
    try {
      return await attempt();
    } catch (error) {
      if (!isSourceContainmentRefusal(error)) throw error;
      pendingAfter = await failedChatRetrySourceStopPending(db, input.companyId, sourceRunId);
      if ((!pendingBefore && !pendingAfter) || Date.now() >= deadline) throw error;
    }
    // The stop settled during the refused attempt: read the authority again
    // now, once. A later flip waits for the normal poll interval.
    if (!pendingAfter && !settledRetry) {
      settledRetry = true;
      continue;
    }
    if (!announced) {
      announced = true;
      await input.onWait?.();
    }
    await delay(Math.min(input.pollMs ?? FAILED_CHAT_RETRY_SOURCE_STOP_POLL_MS, Math.max(0, deadline - Date.now())),
      input.signal);
  }
}
