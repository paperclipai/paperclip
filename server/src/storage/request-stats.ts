import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-operation durable-storage request statistics, collected without
 * threading a sink through every provider call. A caller opens a collector
 * around a save or restore; every S3 request sent inside it adds its SDK
 * attempts and retry delay, and the multipart uploader adds its own backoff.
 * Counts only: no keys, paths or provider text. The run log and save timing
 * record them so a slow or retried storage call is visible.
 */
export type StorageRequestStats = {
  /** S3 requests sent (each may take several SDK attempts). */
  requests: number;
  /** SDK attempts across those requests. */
  attempts: number;
  /** Requests that ultimately failed. */
  failedRequests: number;
  /** Time the SDK spent waiting between its own retries. */
  retryDelayMs: number;
  /** Multipart parts uploaded. */
  parts: number;
  /** Part sends the backend rate-limited (503, 429, SlowDown). */
  throttled: number;
  /** Time the multipart uploader waited before resending a part. */
  backoffMs: number;
};

const current = new AsyncLocalStorage<StorageRequestStats>();

export function newStorageRequestStats(): StorageRequestStats {
  return { requests: 0, attempts: 0, failedRequests: 0, retryDelayMs: 0, parts: 0, throttled: 0, backoffMs: 0 };
}

/** Runs `work` with `stats` collecting every durable-storage request it sends. */
export function collectStorageRequestStats<T>(stats: StorageRequestStats, work: () => Promise<T>): Promise<T> {
  return current.run(stats, work);
}

function metadataOf(value: unknown): { attempts?: unknown; totalRetryDelay?: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metadata = (value as { $metadata?: unknown }).$metadata;
  return metadata && typeof metadata === "object" ? metadata as { attempts?: unknown; totalRetryDelay?: unknown } : undefined;
}

const count = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

/** Records one S3 request's outcome from its SDK response or error metadata. */
export function recordStorageRequest(outcome: unknown, failed: boolean): void {
  const stats = current.getStore();
  if (!stats) return;
  const metadata = metadataOf(outcome);
  stats.requests += 1;
  stats.attempts += count(metadata?.attempts, 1);
  stats.retryDelayMs += count(metadata?.totalRetryDelay, 0);
  if (failed) stats.failedRequests += 1;
}

export function recordStoragePart(): void {
  const stats = current.getStore();
  if (stats) stats.parts += 1;
}

/** Records a part send the backend rate-limited (503, 429, SlowDown), including a final one. */
export function recordStorageThrottle(): void {
  const stats = current.getStore();
  if (stats) stats.throttled += 1;
}

/** Records a wait before resending a part. */
export function recordStorageBackoff(waitMs: number): void {
  const stats = current.getStore();
  if (stats) stats.backoffMs += count(waitMs, 0);
}

/** Counts a request sent outside the failure-diagnostics wrapper (cleanup), keeping its error handling. */
export async function withStorageRequestStats<T>(send: () => Promise<T>): Promise<T> {
  try {
    const result = await send();
    recordStorageRequest(result, false);
    return result;
  } catch (error) {
    recordStorageRequest(error, true);
    throw error;
  }
}
