import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";

const execFile = promisify(execFileCallback);

// The identity-keyed host credential cache keeps one usable subscription
// credential per identity (`account_id`) in a SEPARATE host store, outside the
// shared Codex home and outside the symlink allowlist. The cache is additive: it
// never changes the copy-back path, the fail-closed decision predicate, or the
// host default store overwrite. It only refreshes an identity the host already
// holds. It never seeds an empty host store and never picks a credential at
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
// and inbound restore run. The predicate answers one question — "should the
// caller replace `destination` with `source`?" — purely by argument order (first
// = source, second = destination). Exit 10 = use source; exit 20 = keep
// destination. A leading `--seed-if-dest-absent` flag adds one opt-in behaviour:
// fill an ABSENT destination slot from a usable subscription source. The
// predicate only reads the two files and exits with a code; it never prints
// token bytes.
const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./codex-auth-merge-decision.cjs", import.meta.url),
);
const SEED_IF_DEST_ABSENT_FLAG = "--seed-if-dest-absent";
const USE_SOURCE_EXIT = 10;
const KEEP_DESTINATION_EXIT = 20;

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
 * The `account_id` is sanitized by {@link toCacheKey}. After the join, this
 * verifies the resolved entry path stays under the cache root and ends at exactly
 * `<safeAccountId>/auth.json`. This function does no filesystem work; it is safe
 * for a read path (the vend and the clear). (Security condition 3.)
 */
export function resolveCodexAuthCacheEntryPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  companyId: string,
): string {
  const resolvedRoot = resolveCodexAuthCacheDir(env, companyId);
  const safeKey = toCacheKey(accountId);
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
 * private (mode 0700), each guarded by `lstat`. Use this on the write path
 * before the cache slot is written.
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

/**
 * Reads the usable subscription `account_id` from an `auth.json` payload. Returns
 * `null` for an absent, unusable, or api-key credential (no subscription
 * identity). This mirrors `parseAuth` in `codex-auth-merge-decision.cjs`; keep
 * the two in step when the auth format changes.
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
  const accountId = typeof tokenRecord.account_id === "string" ? tokenRecord.account_id.trim() : "";
  const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
    const value = tokenRecord[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!accountId || !hasTokenMaterial) {
    return null;
  }
  return accountId;
}

async function decideExitCode(
  sourcePath: string,
  destinationPath: string,
  options: { seedIfDestAbsent?: boolean } = {},
): Promise<number> {
  const args = options.seedIfDestAbsent
    ? [DECISION_SCRIPT_PATH, SEED_IF_DEST_ABSENT_FLAG, sourcePath, destinationPath]
    : [DECISION_SCRIPT_PATH, sourcePath, destinationPath];
  try {
    await execFile("node", args);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === USE_SOURCE_EXIT || code === KEEP_DESTINATION_EXIT) {
      return code;
    }
    const detail =
      typeof code === "string"
        ? `node could not be executed (${code})`
        : typeof code === "number"
        ? `unexpected predicate exit code ${code}`
        : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`codex auth cache decision predicate failed: ${detail}`);
  }
  throw new Error("codex auth cache decision predicate exited 0 (expected 10 or 20)");
}

export type WriteCodexAuthCacheEntryOutcome = "written" | "kept-slot";

/**
 * Writes `sandboxAuthBytes` into its per-identity cache slot when the slot is
 * absent, or when the source is a strictly-newer same-identity subscription
 * credential (Phase 2 seed mode). The mutation runs under the merge lock on the
 * slot directory. Never logs token bytes or a raw `account_id`.
 */
export async function writeCodexAuthCacheEntry(input: {
  sandboxAuthBytes: Buffer;
  cacheEntryPath: string;
  log: (line: string) => void | Promise<void>;
}): Promise<WriteCodexAuthCacheEntryOutcome> {
  const { sandboxAuthBytes, cacheEntryPath, log } = input;
  const cacheEntryDir = path.dirname(cacheEntryPath);
  return withDirectoryMergeLock(cacheEntryDir, async () => {
    const stagedTempPath = path.join(
      cacheEntryDir,
      `.auth.json.cache-source-${process.pid}-${randomUUID()}.tmp`,
    );
    const handle = await open(stagedTempPath, "wx", 0o600);
    try {
      await handle.writeFile(sandboxAuthBytes);
      await handle.close();
      const decision = await decideExitCode(stagedTempPath, cacheEntryPath, {
        seedIfDestAbsent: true,
      });
      if (decision === USE_SOURCE_EXIT) {
        await rename(stagedTempPath, cacheEntryPath);
        await log("[paperclip] Codex auth cache: wrote the per-identity cache slot at mode 0600.");
        return "written";
      }
      await log(
        "[paperclip] Codex auth cache: kept the cache slot (source is not a strictly-newer same-identity subscription credential).",
      );
      return "kept-slot";
    } finally {
      await handle.close().catch(() => undefined);
      await rm(stagedTempPath, { force: true }).catch(() => undefined);
    }
  });
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
      const decision = await decideExitCode(stagedTempPath, sharedHomeAuthPath);
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
  });
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
  await withDirectoryMergeLock(entryDir, async () => {
    await rm(entryDir, { recursive: true, force: true });
  });
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
