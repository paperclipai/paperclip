import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const pendingTemporaryDirectoryRemovals = new Set<string>();
const cleanupLedger = path.join(resolvePaperclipInstanceRoot(), "pending-temporary-directory-cleanup.json");
let wakeTemporaryDirectoryCleanupWork: (() => void) | undefined;
let cleanupStateLoaded: Promise<void> | undefined;
let cleanupStateReady = false;
let cleanupLedgerWrite = Promise.resolve();

registerIdleLocalWorkProbe(() => {
  if (!cleanupStateReady) return "unknown";
  return pendingTemporaryDirectoryRemovals.size > 0 ? "present" : "none";
});

function validTemporaryCleanupPath(directory: string) {
  if (!path.isAbsolute(directory) || path.basename(directory) === "..") return false;
  const parentName = path.basename(path.dirname(directory));
  const name = path.basename(directory);
  const tempRoot = path.resolve(os.tmpdir());
  let canonicalTempRoot = tempRoot;
  try { canonicalTempRoot = realpathSync.native(tempRoot); } catch { /* The temp directory may not exist yet. */ }
  const parent = path.dirname(directory);
  return ((parent === tempRoot || parent === canonicalTempRoot) &&
    (name.startsWith("paperclip-ai-") || name.startsWith("paperclip-preserve-"))) ||
    (parentName === ".paperclip-recovered" && name.startsWith(".preparing-"));
}

async function loadTemporaryCleanupState() {
  if (!cleanupStateLoaded) cleanupStateLoaded = (async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(cleanupLedger, "utf8"));
      if (Array.isArray(parsed)) for (const entry of parsed)
        if (typeof entry === "string" && validTemporaryCleanupPath(entry)) pendingTemporaryDirectoryRemovals.add(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  })();
  const loading = cleanupStateLoaded;
  try {
    await loading;
    cleanupStateReady = true;
  } catch (error) {
    if (cleanupStateLoaded === loading) cleanupStateLoaded = undefined;
    logger.warn({ err: error }, "Could not load persisted temporary-directory cleanup work; retrying");
    throw error;
  }
}

function persistTemporaryCleanupState() {
  if (!cleanupStateReady) throw new Error("Cannot persist cleanup work before loading its ledger");
  cleanupLedgerWrite = cleanupLedgerWrite.catch(() => {}).then(async () => {
    const entries = [...pendingTemporaryDirectoryRemovals];
    await mkdir(path.dirname(cleanupLedger), { recursive: true, mode: 0o700 });
    const temporary = `${cleanupLedger}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await rename(temporary, cleanupLedger);
  });
  return cleanupLedgerWrite;
}

async function retryPendingTemporaryDirectoryRemovals() {
  await loadTemporaryCleanupState();
  const failures: unknown[] = [];
  for (const directory of [...pendingTemporaryDirectoryRemovals]) {
    let removed = false;
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      removed = pendingTemporaryDirectoryRemovals.delete(directory);
      await persistTemporaryCleanupState();
    } catch (error) {
      if (removed) pendingTemporaryDirectoryRemovals.add(directory);
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Temporary directory cleanup failed");
}

export function registerTemporaryDirectoryCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
) {
  const worker = coordinator.register(DELIVERY_QUEUES.temporaryDirectoryCleanup, {
    retryMs: 30_000,
    runDuringDrain: true,
    run: retryPendingTemporaryDirectoryRemovals,
    hasPending: async () => { await loadTemporaryCleanupState(); return pendingTemporaryDirectoryRemovals.size > 0; },
  });
  wakeTemporaryDirectoryCleanupWork = worker.wake;
  return worker;
}

export async function retryTemporaryDirectoryCleanupNow() {
  await retryPendingTemporaryDirectoryRemovals();
}

export async function queueTemporaryDirectoryCleanup(directory: string) {
  if (!validTemporaryCleanupPath(directory)) throw new Error("Refusing cleanup for an unowned temporary directory");
  // Own the request before trying to read prior durable work. If that read is
  // temporarily unavailable, the worker retains this path in memory and can
  // persist it together with the old queue after a successful retry.
  pendingTemporaryDirectoryRemovals.add(directory);
  try {
    await loadTemporaryCleanupState();
  } catch (error) {
    wakeTemporaryDirectoryCleanupWork?.();
    throw error;
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    pendingTemporaryDirectoryRemovals.delete(directory);
    await persistTemporaryCleanupState();
  } catch (error) {
    pendingTemporaryDirectoryRemovals.add(directory);
    await persistTemporaryCleanupState();
    logger.warn({ dir: directory, err: error }, "Failed to remove temporary directory; cleanup remains queued");
    wakeTemporaryDirectoryCleanupWork?.();
  }
}
