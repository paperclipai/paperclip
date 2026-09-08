import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { toAccountHandle } from "@paperclipai/shared";
import { USE_SOURCE_EXIT, decideCodexAuthMerge } from "./codex-auth-merge-decision.js";
import { writeCredentialSeedOrNewer } from "./codex-auth-seed-write.js";

// The identity-keyed host credential store keeps one usable subscription
// credential per identity (`account_id`) in a SEPARATE host tree, outside the
// shared Codex home and outside the symlink allowlist. Each identity's entry
// directory doubles as that account's addressable home: the device-login
// promotion writes the durable credential there, and a company secret names the
// directory by path. The store also still backs the identity-anchored vend: it
// never changes the copy-back path, the fail-closed decision predicate, or the
// host default store overwrite, it only refreshes an identity the host already
// holds, it never seeds an empty host store, and it never picks a credential at
// random.

const CACHE_DIR_NAME = "codex-auth-cache";
const CACHE_ENTRY_FILE = "auth.json";
// A private directory (owner rwx only). 0o700 has no group/other bits, so a
// standard umask can never widen it.
const PRIVATE_DIR_MODE = 0o700;

// One default-on off-switch. When the flag is an explicit falsy value the cache
// write and the cache vend become no-ops. The host default overwrite is
// unchanged in both states.
export const CODEX_AUTH_CACHE_OFF_SWITCH_ENV = "PAPERCLIP_CODEX_AUTH_CACHE";
const FALSY_ENV_RE = /^(0|false|no|off)$/i;

// The cache reuses the same direction-agnostic decision predicate the copy-back
// and inbound restore run, through the shared `decideCodexAuthMerge` entry point.
// The predicate answers one question — "should the caller replace `destination`
// with `source`?" — purely by argument order (first = source, second =
// destination). Exit 10 = use source; exit 20 = keep destination. The opt-in seed
// mode fills an ABSENT destination slot from a usable subscription source.

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * True when the cache is enabled. The cache is on by default. It turns off only
 * when {@link CODEX_AUTH_CACHE_OFF_SWITCH_ENV} is an explicit falsy value
 * (`0`, `false`, `no`, or `off`).
 */
export function isCodexAuthCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CODEX_AUTH_CACHE_OFF_SWITCH_ENV];
  if (typeof raw !== "string") return true;
  return !FALSY_ENV_RE.test(raw.trim());
}

/**
 * Sanitizes one raw value to a single safe path segment. Rejects an empty value,
 * a relative segment (`.` or `..`), a path separator (`/` or `\`), and a NUL
 * byte, so the value can never become a path traversal. Returns the trimmed,
 * safe segment. The `label` names the value in the error message. (Security
 * condition 3.)
 */
function toSafePathSegment(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new Error(`codex auth cache: ${label} is empty`);
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`codex auth cache: ${label} is a relative path segment`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`codex auth cache: ${label} contains a path separator`);
  }
  // Defense in depth: a safe segment is exactly its own basename. Anything else
  // carries a separator or a relative segment the checks above must have caught.
  if (path.basename(trimmed) !== trimmed) {
    throw new Error(`codex auth cache: ${label} is not a single path segment`);
  }
  return trimmed;
}

/**
 * Sanitizes an `account_id` to one safe path segment. Rejects an empty value, a
 * relative segment (`.` or `..`), a path separator, and a NUL byte, so a raw
 * `account_id` can never become a path traversal. Returns the trimmed, safe
 * segment. (Security condition 3.)
 */
export function toCacheKey(accountId: string): string {
  return toSafePathSegment(accountId, "account_id");
}

/**
 * Resolves the company-scoped cache root under the same isolation boundary as
 * the managed Codex home (`resolveManagedCodexHomeDir`). The root is always
 * company-scoped, so a Codex credential can never cross a company boundary.
 * There is no instance-global fallback root: `companyId` is required, and an
 * empty value is a fail-loud error. `companyId` is sanitized to a single safe
 * path segment, so a traversal value (`..`, `/etc`, `a/b`) can never make the
 * cache root escape the `companies/` directory. Every downstream path (the
 * entry path, the vend, and the clear) inherits this guard. (Security
 * condition 1.)
 */
export function resolveCodexAuthCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
): string {
  const safeCompanyId = toSafePathSegment(companyId, "companyId");
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", safeCompanyId, CACHE_DIR_NAME);
}

/**
 * Resolves the entry path for one identity: `<cacheRoot>/<safeAccountId>/auth.json`.
 * The `account_id` is validated first by {@link toAccountHandle} (a strict
 * allowlist), the entry point of this function, then sanitized again by
 * {@link toCacheKey} (a denylist) as a second, independent layer. After the
 * join, this verifies the resolved entry path stays under the cache root and
 * ends at exactly `<safeAccountId>/auth.json`. This function does no filesystem
 * work; it is safe for a read path (the vend and the clear). (Security
 * condition 3.)
 */
export function resolveCodexAuthCacheEntryPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  companyId: string,
): string {
  const handle = toAccountHandle(accountId);
  if (!handle) {
    throw new Error("codex auth cache: account_id is not a valid account handle");
  }
  const resolvedRoot = resolveCodexAuthCacheDir(env, companyId);
  const safeKey = toCacheKey(handle);
  const entryDir = path.resolve(resolvedRoot, safeKey);
  const entryPath = path.resolve(entryDir, CACHE_ENTRY_FILE);
  const expectedEntryPath = path.join(resolvedRoot, safeKey, CACHE_ENTRY_FILE);
  if (
    !entryDir.startsWith(resolvedRoot + path.sep) ||
    path.dirname(entryDir) !== resolvedRoot ||
    entryPath !== expectedEntryPath
  ) {
    throw new Error("codex auth cache: resolved entry path escapes the cache root");
  }
  return entryPath;
}

/**
 * Ensures one directory exists and is private (mode 0700). Fails closed with
 * `lstat` (not `stat`) when the existing path is a symlink or a non-directory,
 * so the cache never writes through a planted symlink. (Security condition 3.)
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  const existing = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("codex auth cache: cache path is a symlink or a non-directory");
    }
    return;
  }
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Resolves the entry path and creates the cache root and the entry directory
 * private (mode 0700), each guarded by `lstat`. The `account_id` is validated
 * at the entry point of this function through {@link resolveCodexAuthCacheEntryPath}.
 * Use this on the write path before the entry is written.
 */
export async function ensureCodexAuthCacheEntryDir(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  companyId: string,
): Promise<string> {
  const entryPath = resolveCodexAuthCacheEntryPath(env, accountId, companyId);
  await ensurePrivateDir(resolveCodexAuthCacheDir(env, companyId));
  await ensurePrivateDir(path.dirname(entryPath));
  return entryPath;
}

export interface EnsureCodexAuthCacheEntryDirExclusiveResult {
  /** The entry path: `<accountHomeDir>/auth.json`. */
  entryPath: string;
  /** True only when this exact call found the account's own home directory
   *  absent and created it. */
  created: boolean;
}

/**
 * Same as {@link ensureCodexAuthCacheEntryDir}, but the absence check and the
 * directory creation run inside one lock keyed to the company-scoped cache
 * root. Two different logins for the SAME Codex account can promote at the
 * same time (each login owns its own promotion slot), so a plain
 * check-then-create sequence lets both concurrent callers see the slot as
 * absent and both report `created: true`. Under this lock, only the caller
 * that truly finds the slot absent gets `created: true`; the other caller
 * correctly reports `created: false` and so never deletes a home the first
 * caller's login already wrote to and named with a company secret.
 */
export async function ensureCodexAuthCacheEntryDirExclusive(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  companyId: string,
): Promise<EnsureCodexAuthCacheEntryDirExclusiveResult> {
  const cacheRoot = resolveCodexAuthCacheDir(env, companyId);
  await ensurePrivateDir(cacheRoot);
  return withDirectoryMergeLock(
    cacheRoot,
    async () => {
      const entryPath = resolveCodexAuthCacheEntryPath(env, accountId, companyId);
      const entryDir = path.dirname(entryPath);
      const created = await lstat(entryDir)
        .then(() => false)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return true;
          throw error;
        });
      await ensurePrivateDir(entryDir);
      return { entryPath, created };
    },
    env,
  );
}

/**
 * Resolves a per-company, named lock target directory under the same
 * instance-scoped `companies/<companyId>/` tree the cache root and the
 * promotion lock use. Two callers that pass the same `lockName` for the same
 * `companyId` always resolve the same directory, so they share one lock; two
 * different `lockName` values never share a lock key, so a caller that holds
 * one of these named locks can still call {@link ensureCodexAuthCacheEntryDirExclusive}
 * (which locks the cache root) or another named lock without nesting a lock
 * inside itself.
 */
function resolveCodexAuthCacheNamedLockDir(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
  lockName: string,
): string {
  const safeCompanyId = toSafePathSegment(companyId, "companyId");
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", safeCompanyId, lockName);
}

/**
 * Serializes one company's whole device-login promotion sequence: the
 * account-home directory create-or-reuse decision, the credential write, and
 * the secret bind or cleanup that follows. Two different logins for the SAME
 * Codex account run this sequence one at a time under this lock, so no login
 * can decide to delete the shared account-home directory while another
 * login's flow is still mid-way through writing its credential or binding
 * its own secret to that same directory.
 *
 * `ensureCodexAuthCacheEntryDirExclusive` alone is not enough: it locks only
 * the short directory-creation step, so its lock is already released by the
 * time a login reaches the secret bind. A second login can then write its
 * credential and be about to bind its own secret while the first login's
 * later, unrelated secret-write failure decides to remove the directory both
 * logins now share, deleting a credential home the second login still needs.
 * Holding this lock across the full sequence for every login closes that
 * window: a login that must clean up its own directory always finishes that
 * cleanup, including the directory-recreation of any later login that lands
 * on the now-empty slot, before the next login's sequence starts.
 */
export async function withCodexAccountHomePromotionLock<T>(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = resolveCodexAuthCacheNamedLockDir(env, companyId, "codex-auth-cache-promotion-lock");
  await ensurePrivateDir(lockDir);
  return withDirectoryMergeLock(lockDir, fn, env);
}

/**
 * Serializes one company's writes to the literal value of any
 * `local_encrypted` company secret against the account-home cleanup's
 * claimant scan in {@link withCodexAccountHomePromotionLock}'s caller. Only a
 * `local_encrypted` secret can hold a literal directory path, so this is the
 * one provider a cleanup claimant scan must trust. Without this lock, a
 * secret create or rotation can commit its new value after the scan's last
 * pass finds no claimant but before the cleanup deletes the directory: the
 * scan and the write never observe each other, so the write's new value
 * survives past a directory the delete has already removed.
 *
 * The secrets service holds this lock for the full duration of a
 * `local_encrypted` secret's create or rotate call. A cleanup claimant scan
 * holds it for the full duration of its final check-and-delete step. The two
 * critical sections can then never interleave: a write that starts first
 * finishes (and becomes visible to the scan) before the scan's lock-holding
 * check runs, and a write that starts after the scan's lock-holding check
 * finishes only commits once the scan (and any delete it decided on) is
 * done, so it can never name a directory the delete just removed without the
 * scan having had a chance to see it first.
 *
 * This is a separate lock directory from
 * {@link withCodexAccountHomePromotionLock}'s, so a device-login promotion
 * (which holds that lock for its whole sequence, including its own secret
 * create) can still call into a secrets-service write that takes this lock
 * without deadlocking on itself.
 */
export async function withAccountHomeSecretMutationLock<T>(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = resolveCodexAuthCacheNamedLockDir(env, companyId, "codex-account-home-secret-mutation-lock");
  await ensurePrivateDir(lockDir);
  return withDirectoryMergeLock(lockDir, fn, env);
}

/**
 * Confirms a `local_encrypted` secret value that names a directory under this
 * company's Codex account-home cache root still exists on disk. Call this
 * inside {@link withAccountHomeSecretMutationLock}, before a create or a
 * rotate commits the value.
 *
 * The lock alone stops a write and the account-home cleanup's
 * check-and-delete from interleaving; it does not stop them from running in
 * either order. When the cleanup's check-and-delete runs first — it finds no
 * secret names the directory, because this write had not committed yet, and
 * removes the directory — a write that was only queued behind the lock still
 * goes on, once the lock frees, to commit the very directory the cleanup
 * just removed. That would leave an active secret naming a directory that
 * does not exist. This check closes that window: a write whose value would
 * name a directory the cleanup already removed fails instead of committing.
 *
 * A value outside this company's cache root is left alone. Only a value
 * under the cache root can ever be an account-home directory, so this never
 * rejects an unrelated `local_encrypted` secret write, such as an API key or
 * a hand-typed token.
 */
export async function assertAccountHomeCacheDirStillValid(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
  value: string,
): Promise<void> {
  const cacheRoot = resolveCodexAuthCacheDir(env, companyId);
  if (!value.startsWith(cacheRoot + path.sep)) return;
  const exists = await lstat(value)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (!exists) {
    throw new Error(
      "codex auth cache: account-home directory no longer exists; refusing to write a secret that names it",
    );
  }
}

/**
 * Reads the usable subscription `account_id` from an `auth.json` payload. Returns
 * `null` for an absent, unusable, or api-key credential (no subscription
 * identity). This mirrors `parseAuth` in `codex-auth-merge-decision.cjs`; keep
 * the two in step when the auth format changes.
 *
 * The returned value is the exact, untrimmed `account_id` string. A caller
 * passes it on to {@link toAccountHandle} unchanged: that function is the
 * one place that decides whether surrounding whitespace is acceptable, and it
 * must see the raw value to reject an identifier that differs from another
 * one only by whitespace. Trimming here, before that check runs, would let
 * two distinct identifiers collapse onto the same account handle.
 */
export function readSubscriptionAccountId(bytes: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const apiKey = record.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return null;
  }
  const tokens = record.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return null;
  }
  const tokenRecord = tokens as Record<string, unknown>;
  const rawAccountId = typeof tokenRecord.account_id === "string" ? tokenRecord.account_id : "";
  // A blank-or-whitespace-only value is absent; a value with real content
  // keeps its exact, untrimmed form.
  const accountId = rawAccountId.trim().length > 0 ? rawAccountId : "";
  const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
    const value = tokenRecord[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!accountId || !hasTokenMaterial) {
    return null;
  }
  return accountId;
}

export type WriteCodexAuthCacheEntryOutcome = "written" | "kept-slot";

/**
 * Writes `sandboxAuthBytes` into its per-identity cache slot when the slot is
 * absent, or when the source is a strictly-newer same-identity subscription
 * credential (seed mode). The mutation runs under the merge lock on the slot
 * directory, through the shared {@link writeCredentialSeedOrNewer} writer. Never
 * logs token bytes or a raw `account_id`.
 */
export async function writeCodexAuthCacheEntry(input: {
  sandboxAuthBytes: Buffer;
  cacheEntryPath: string;
  log: (line: string) => void | Promise<void>;
  /** Environment for the merge lock root. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}): Promise<WriteCodexAuthCacheEntryOutcome> {
  const outcome = await writeCredentialSeedOrNewer({
    sourceBytes: input.sandboxAuthBytes,
    destinationPath: input.cacheEntryPath,
    seedIfDestAbsent: true,
    log: input.log,
    writtenLine: "[paperclip] Codex auth cache: wrote the per-identity cache slot at mode 0600.",
    keptLine:
      "[paperclip] Codex auth cache: kept the cache slot (source is not a strictly-newer same-identity subscription credential).",
    tempPrefix: "auth.json.cache-source",
    errorLabel: "codex auth cache",
    env: input.env,
  });
  return outcome === "written" ? "written" : "kept-slot";
}

export type VendCodexAuthOutcome = "vended" | "kept-host" | "no-host-identity";

/**
 * Refreshes the identity the host already holds with a strictly-newer cached
 * credential of the same `account_id`. Identity-anchored:
 *
 * 1. Read the host identity from `sharedHomeAuthPath` first.
 * 2. When the host holds no usable subscription identity, do nothing. The vend
 *    never picks a credential from the cache at random (matrix rows 3, 4).
 * 3. Resolve ONLY that exact identity's cache slot. The vend never scans the
 *    cache root. (Security condition 4.)
 * 4. Run the DEFAULT-mode predicate (cache slot as source, shared home as
 *    destination). Install the cache copy only when it is strictly newer for the
 *    same identity.
 *
 * The vend never changes identity and never stages a spent single-use refresh
 * token (the strictly-newer rule guards it). Never logs token bytes or a raw
 * `account_id`.
 */
export async function selectVendCredential(
  sharedHomeAuthPath: string,
  resolveCacheEntryPath: (accountId: string) => string,
  log: (line: string) => void | Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VendCodexAuthOutcome> {
  const hostBytes = await readFile(sharedHomeAuthPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const hostAccountId = hostBytes ? readSubscriptionAccountId(hostBytes) : null;
  if (!hostAccountId) {
    // No host identity: the vend does nothing (identity-anchor rule).
    return "no-host-identity";
  }

  let cacheEntryPath: string;
  try {
    cacheEntryPath = resolveCacheEntryPath(hostAccountId);
  } catch {
    // A host identity that cannot form a safe cache key never vends.
    return "no-host-identity";
  }

  const hostDir = path.dirname(sharedHomeAuthPath);
  return withDirectoryMergeLock(hostDir, async () => {
    // Read the cached bytes under the lock, then stage exactly those bytes into a
    // private (0600) temp next to the host target. The predicate reads the temp,
    // so the vend installs exactly the bytes the predicate approved. This closes
    // the read-after-validate skew: a separate reader of `cacheEntryPath` could
    // otherwise see different bytes than the ones installed. The rename over the
    // host target stays device-local and atomic.
    const cacheBytes = await readFile(cacheEntryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!cacheBytes) {
      await log("[paperclip] Codex auth cache: no cached credential for the host identity; host credential kept.");
      return "kept-host";
    }
    const stagedTempPath = path.join(
      hostDir,
      `.auth.json.vend-${process.pid}-${randomUUID()}.tmp`,
    );
    const handle = await open(stagedTempPath, "wx", 0o600);
    try {
      await handle.writeFile(cacheBytes);
      await handle.close();
      // Default-mode predicate: install the cache copy only when it is strictly
      // newer for the SAME identity. Same-identity + strictly-newer keeps the
      // change additive and semantics-preserving.
      const decision = await decideCodexAuthMerge(stagedTempPath, sharedHomeAuthPath, {
        errorLabel: "codex auth cache",
      });
      if (decision === USE_SOURCE_EXIT) {
        await rename(stagedTempPath, sharedHomeAuthPath);
        await log(
          "[paperclip] Codex auth cache: refreshed the host credential with a strictly-newer cached copy of the same identity at mode 0600.",
        );
        return "vended";
      }
      await log(
        "[paperclip] Codex auth cache: host credential kept (the cached copy is not strictly newer for the same identity).",
      );
      return "kept-host";
    } finally {
      await handle.close().catch(() => undefined);
      await rm(stagedTempPath, { force: true }).catch(() => undefined);
    }
  }, env);
}

/**
 * Removes exactly one identity slot from the cache. The `account_id` is
 * sanitized by {@link toCacheKey}, so the removal can never escape the cache
 * root. A missing slot is a benign no-op. Any other removal error is fail-loud.
 */
export async function clearCodexAuthCacheEntry(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  companyId: string,
): Promise<void> {
  const entryPath = resolveCodexAuthCacheEntryPath(env, accountId, companyId);
  const entryDir = path.dirname(entryPath);
  // A missing slot is a benign no-op. Pre-check before the lock: the merge lock
  // sits next to the slot under the cache root, so locking a slot whose cache
  // root does not exist would fail on the lock directory itself.
  const existing = await lstat(entryDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return;
  await withDirectoryMergeLock(
    entryDir,
    async () => {
      await rm(entryDir, { recursive: true, force: true });
    },
    env,
  );
}

/**
 * Removes every slot in the company-scoped cache root. A missing cache root is a
 * benign no-op.
 */
export async function clearCodexAuthCache(
  env: NodeJS.ProcessEnv = process.env,
  companyId: string,
): Promise<void> {
  const cacheDir = resolveCodexAuthCacheDir(env, companyId);
  await rm(cacheDir, { recursive: true, force: true });
}
