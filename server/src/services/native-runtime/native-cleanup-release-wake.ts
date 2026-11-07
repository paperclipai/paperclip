import type { Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { onNativeSessionCleanupSettled } from "../../vendor/paperclip-runner/index.js";

/**
 * A retained native session close holds task input in the runner's process
 * memory. When the runner releases it, wake deferred execution for that company
 * so a held Retry or message re-evaluates its gate. The wake is a hint only:
 * dispatch repeats every admission check under its own locks.
 */
export function registerNativeCleanupReleaseWake(db: Db, onError: (error: unknown, companyId: string) => void): () => void {
  return onNativeSessionCleanupSettled(({ companyId }) => {
    if (!companyId) return;
    void db.transaction(async tx => notifyDeferredExecutionWork(tx, { companyId }))
      .catch((error: unknown) => onError(error, companyId));
  });
}
