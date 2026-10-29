import { AsyncLocalStorage } from "node:async_hooks";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";

export type RetainedAiCleanupScope = { companyId: string; accountKey: string };
type Cleanup = {
  scope: RetainedAiCleanupScope;
  cleanup: () => Promise<void>;
  retryRetirement?: () => Promise<void>;
  retired: "pending" | "confirmed" | "failed";
  running?: Promise<void>;
  executing?: boolean;
  warned?: boolean;
};
const retained = new Map<string, Set<Cleanup>>();
const reconciling = new Map<string, Promise<void>>();
const homes = new Map<string, RetainedAiCleanupScope>();
const active = new AsyncLocalStorage<ReadonlySet<Cleanup>>();
const key = (scope: RetainedAiCleanupScope) => JSON.stringify([scope.companyId, scope.accountKey]);
registerIdleLocalWorkProbe(() => retained.size ? "present" : "none");

function pending() {
  return unprocessable("The selected AI account is still completing credential cleanup. Retry shortly.", { code: "ai_connection_busy" });
}
function remove(entry: Cleanup) {
  const entries = retained.get(key(entry.scope));
  entries?.delete(entry);
  if (!entries?.size) retained.delete(key(entry.scope));
}
function warn(entry: Cleanup) {
  if (entry.warned) return;
  entry.warned = true;
  logger.warn({ companyId: entry.scope.companyId, code: "AI_CREDENTIAL_CLEANUP_PENDING" }, "Selected AI credential cleanup remains pending");
}
function cleaningScope(scope: RetainedAiCleanupScope) {
  return [...(active.getStore() ?? [])].some(entry => entry.executing && key(entry.scope) === key(scope));
}

/** Check without joining work that may need the mutation lock already held by
 * the caller. A cleanup's own nested journal recovery shares its ownership. */
export function assertAiCredentialCleanupSettled(scope: RetainedAiCleanupScope): void {
  if (!cleaningScope(scope) && retained.get(key(scope))?.size) throw pending();
}
function attempt(entry: Cleanup): Promise<void> {
  if (!retained.get(key(entry.scope))?.has(entry)) return Promise.resolve();
  if (entry.retired === "pending" || (entry.retired === "failed" && !entry.retryRetirement)) return Promise.reject(pending());
  return entry.running ??= active.run(new Set([...(active.getStore() ?? []), entry]), async () => {
    entry.executing = true;
    try {
      if (entry.retired === "failed") {
        await entry.retryRetirement!();
        entry.retired = "confirmed";
      }
      await entry.cleanup(); remove(entry);
    }
    catch (error) {
      // The encrypted journal now owns recovery; the next account preparation
      // reads it before it can launch another provider.
      if (entry.retired === "confirmed" && error instanceof RetiredCredentialRecoveryError) { remove(entry); return; }
      warn(entry);
      throw pending();
    } finally { entry.executing = false; }
  }).finally(() => { entry.running = undefined; });
}

/** A retirement event gets one cleanup attempt. Already-retired failures retry
 * only on the next same-account action, never on an idle timer or SQL scan. */
export function retainAiCredentialCleanup(input: {
  // Accept legacy Google home metadata for compatibility. Only the explicit
  // bindRetainedAiCredentialHome mapping grants home-to-account authority.
  scope: RetainedAiCleanupScope; cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>; home?: string;
}): void {
  const scopeKey = key(input.scope);
  const entries = retained.get(scopeKey) ?? new Set<Cleanup>();
  if ([...entries].some(entry => entry.cleanup === input.cleanup)) return;
  const entry: Cleanup = { scope: { ...input.scope }, cleanup: input.cleanup, retryRetirement: input.retryRetirement,
    retired: input.retired ? "pending" : "confirmed" };
  entries.add(entry); retained.set(scopeKey, entries);
  if (input.retired) void input.retired.then(() => {
    entry.retired = "confirmed";
    return reconcileRetainedAiCleanup(entry.scope).catch(() => undefined);
  }, () => { entry.retired = "failed"; warn(entry); });
}

/** Fail closed before another provider starts. Concurrent attempts join the
 * original cleanup. Nested credential reads skip this account's peer join to
 * avoid recursing into the current callback. The outer bounded pass and final
 * fence still settle every peer before any external provider admission. */
export async function reconcileRetainedAiCleanup(scope: RetainedAiCleanupScope): Promise<void> {
  await Promise.resolve();
  const scopeKey = key(scope);
  if (cleaningScope(scope)) return;
  const existing = reconciling.get(scopeKey);
  if (existing) return existing;
  const operation = (async () => {
    for (const entry of [...(retained.get(scopeKey) ?? [])]) await attempt(entry);
    // A new obligation can arrive while a callback awaits storage. This
    // request attempts its original bounded set and keeps admission closed.
    if (retained.get(scopeKey)?.size) throw pending();
  })();
  reconciling.set(scopeKey, operation);
  try { await operation; }
  finally { if (reconciling.get(scopeKey) === operation) reconciling.delete(scopeKey); }
}

export function bindRetainedAiCredentialHome(home: string, scope: RetainedAiCleanupScope): () => void {
  const bound = { ...scope };
  homes.set(home, bound);
  return () => { if (homes.get(home) === bound) homes.delete(home); };
}
export async function reconcileRetainedAiCleanupForHome(home: string): Promise<void> {
  const scope = homes.get(home);
  if (scope) await reconcileRetainedAiCleanup(scope);
}
export function retainAiCredentialCleanupForHome(home: string, input: {
  cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>;
}): void {
  const scope = homes.get(home);
  if (scope) retainAiCredentialCleanup({ ...input, scope, home });
}
