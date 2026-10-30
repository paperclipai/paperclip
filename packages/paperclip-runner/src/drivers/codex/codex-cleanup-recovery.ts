/**
 * A fresh Codex transport can restore provider state. Retained cleanup retries
 * must go through the server's isolated reconciler so this Issue cannot replay
 * a turn or start a replacement provider before the old process is proven safe.
 */
export function rejectUnsafeCodexCleanupRetry(): never {
  throw new Error("runnerd cleanup retry requires retained native session reconciliation");
}
