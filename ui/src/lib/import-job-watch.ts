/**
 * Client-side bookkeeping for async company import jobs.
 *
 * The import page submits imports as server-side jobs and polls their status,
 * so a dropped connection or a page reload must not lose track of a running
 * import. The job id is mirrored into `sessionStorage` (keyed per company and
 * package) when a job is accepted and removed once it reaches a terminal
 * state, letting the page resume watching after a reload. Jobs live in server
 * memory only: a stored id the server no longer knows (restart, retention
 * expiry) surfaces as a 404 and the stored entry is discarded.
 */

export const IMPORT_JOB_POLL_INTERVAL_MS = 3000;

const STORAGE_PREFIX = "paperclip:company-import-job";

export interface StoredImportJob {
  jobId: string;
  pauseAutomations: boolean;
}

export function importJobStorageKey(companyId: string, packageName: string): string {
  return `${STORAGE_PREFIX}:${companyId}:${packageName}`;
}

export function writeStoredImportJob(storageKey: string, value: StoredImportJob): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (quota, privacy mode); polling still works,
    // only reload-resume is lost.
  }
}

export function clearStoredImportJob(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore storage failures; a stale entry is discarded on the next read.
  }
}

/**
 * Find a stored job for this company. Keys are scoped per package name, so
 * scan the company's prefix; the server allows one live job per user, so at
 * most one non-terminal entry is expected.
 */
export function readStoredImportJob(
  companyId: string,
): (StoredImportJob & { storageKey: string }) | null {
  try {
    const prefix = `${STORAGE_PREFIX}:${companyId}:`;
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = sessionStorage.getItem(key);
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed === "object" && parsed !== null &&
            typeof (parsed as { jobId?: unknown }).jobId === "string"
          ) {
            return {
              jobId: (parsed as { jobId: string }).jobId,
              pauseAutomations: (parsed as { pauseAutomations?: unknown }).pauseAutomations === true,
              storageKey: key,
            };
          }
        } catch {
          // Fall through to discard the malformed entry.
        }
      }
      sessionStorage.removeItem(key);
      index -= 1;
    }
  } catch {
    // Storage unavailable — nothing to resume.
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait one poll interval before the next status request. While the tab is
 * hidden, keep waiting instead of polling: the job runs server-side, so a
 * backgrounded page skips status requests until it is visible again.
 */
export async function waitForNextImportJobPoll(
  intervalMs: number = IMPORT_JOB_POLL_INTERVAL_MS,
): Promise<void> {
  do {
    await sleep(intervalMs);
  } while (typeof document !== "undefined" && document.hidden);
}
