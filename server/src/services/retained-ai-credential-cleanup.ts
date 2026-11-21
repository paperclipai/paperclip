import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";

export type RetainedAiCleanupScope = { companyId: string; accountKey: string };
type Cleanup = {
  scope: RetainedAiCleanupScope;
  home?: string;
  cleanup: () => Promise<void>;
  retryRetirement?: () => Promise<void>;
  retired: "pending" | "confirmed" | "failed";
  running?: Promise<void>;
  executing?: boolean;
  warned?: boolean;
};
const retained = new Map<string, Set<Cleanup>>();
const homes = new Map<string, RetainedAiCleanupScope>();
// Managed homes a runtime is still tearing down (credential write-back in
// flight, home removal pending). They protect exactly like retained entries,
// but they are transient runtime state, not reconcilable cleanups.
const teardownHolds = new Map<string, number>();
const active = new AsyncLocalStorage<ReadonlySet<Cleanup>>();
const key = (scope: RetainedAiCleanupScope) => JSON.stringify([scope.companyId, scope.accountKey]);
registerIdleLocalWorkProbe(() => retained.size ? "present" : "none");

function pending() {
  return unprocessable("This runtime still has unfinished credential cleanup.", { code: "ai_credential_cleanup_pending" });
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
  const entry: Cleanup = { scope: { ...input.scope }, home: input.home, cleanup: input.cleanup, retryRetirement: input.retryRetirement,
    retired: input.retired ? "pending" : "confirmed" };
  entries.add(entry); retained.set(scopeKey, entries);
  if (input.retired) void input.retired.then(() => {
    entry.retired = "confirmed";
    return attempt(entry).catch(() => undefined);
  }, () => { entry.retired = "failed"; warn(entry); });
}

/** The owning runtime has completed write-back (or durable handoff). Retire
 * only its exact obligation before physical removal, including direct retries
 * outside attempt(). Unconfirmed native retirement and other owners stay fenced. */
export function completeRetainedAiCredentialCleanup(scope: RetainedAiCleanupScope, cleanup: () => Promise<void>): void {
  for (const entry of retained.get(key(scope)) ?? []) {
    if (entry.cleanup === cleanup && entry.retired === "confirmed") remove(entry);
  }
}

export async function reconcileRetainedAiCleanup(scope: RetainedAiCleanupScope): Promise<void> {
  await Promise.resolve();
  const scopeKey = key(scope);
  if (cleaningScope(scope)) return;
  for (const entry of [...(retained.get(scopeKey) ?? [])]) await attempt(entry);
}

export function bindRetainedAiCredentialHome(home: string, scope: RetainedAiCleanupScope): () => void {
  const bound = { ...scope };
  homes.set(home, bound);
  return () => { if (homes.get(home) === bound) homes.delete(home); };
}

/**
 * Hold `home` protected for the whole runtime teardown: from home creation
 * until the runtime's cleanup settles (write-back finished and home removed,
 * or the failure converted into an ordinary retained cleanup). Without this
 * hold, a sweep that observes the run already terminal and its process group
 * exited could delete the directory — and the only copy of a refreshed
 * credential in it — while the executor's finally block is still reading or
 * writing `auth.json`.
 */
export function acquireAiCredentialTeardownHold(home: string): () => void {
  const resolved = path.resolve(home);
  teardownHolds.set(resolved, (teardownHolds.get(resolved) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = teardownHolds.get(resolved);
    if (count === undefined) return;
    if (count <= 1) teardownHolds.delete(resolved);
    else teardownHolds.set(resolved, count - 1);
  };
}

/**
 * Canonical filesystem identity of `p`: `undefined` means the path is verified
 * absent (ENOENT), `null` means the identity cannot be verified (permissions,
 * symlink loop, ...) and callers must not guess.
 */
async function canonicalIdentity(p: string): Promise<string | null | undefined> {
  try {
    return await fs.realpath(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
}

function isAtOrUnder(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(prefix);
}

/**
 * True while a pending credential write-back still owns a home at or under
 * `dir` — a retained cleanup entry or an active runtime teardown hold:
 * every removal entrance (direct cleanup and the orphan sweep) must keep the
 * directory until the retained cleanup retires the home or the teardown
 * settles, or the only copy of a rotated credential is lost.
 *
 * Provider homes are registered after `realpath` (Antigravity canonicalizes
 * its home) while the scratch directory may be reached through a symlinked
 * ancestor, so a purely lexical comparison can miss a home that is physically
 * inside. Both sides are therefore compared as canonical identities, and a
 * directory whose relation to a retained home cannot be verified is kept.
 */
export async function retainedAiCredentialCleanupHomeInside(dir: string): Promise<boolean> {
  const retainedHomes: string[] = [];
  for (const entries of retained.values()) {
    for (const entry of entries) {
      // The active retry owns this cleanup and may retire its own home after
      // write-back. Other entries and teardown holds remain protective.
      if (entry.executing && active.getStore()?.has(entry)) continue;
      if (entry.home) retainedHomes.push(entry.home);
    }
  }
  for (const held of teardownHolds.keys()) retainedHomes.push(held);
  if (retainedHomes.length === 0) return false;
  const root = path.resolve(dir);
  if (retainedHomes.some((home) => isAtOrUnder(root, path.resolve(home)))) return true;
  const canonicalRoot = await canonicalIdentity(root);
  if (canonicalRoot === null) return true;
  if (canonicalRoot === undefined) return false;
  for (const home of retainedHomes) {
    const canonicalHome = await canonicalIdentity(path.resolve(home));
    if (canonicalHome === null) return true;
    if (canonicalHome !== undefined && isAtOrUnder(canonicalRoot, canonicalHome)) return true;
  }
  return false;
}
export async function reconcileRetainedAiCleanupForHome(home: string): Promise<void> {
  const scope = homes.get(home);
  if (!scope || cleaningScope(scope)) return;
  for (const entry of [...(retained.get(key(scope)) ?? [])]) {
    if (entry.home === home) await attempt(entry);
  }
}
export function retainAiCredentialCleanupForHome(home: string, input: {
  cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>;
}): void {
  const scope = homes.get(home);
  if (scope) retainAiCredentialCleanup({ ...input, scope, home });
}
