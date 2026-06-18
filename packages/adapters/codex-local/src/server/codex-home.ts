import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const AUTH_LOCK_TIMEOUT_MS = 5_000;
const AUTH_LOCK_RETRY_MS = 50;
const RESTORED_AUTH_SYMLINK_MESSAGE =
  "[paperclip] Restored auth.json symlink (target was detached regular file; wrote rotated token back to source).";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "codex-home")
    : path.resolve(instanceRoot, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

export async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    // A previous Paperclip version copied this file into the managed home
    // instead of symlinking it. Codex refresh tokens rotate and are
    // single-use, so a stale copy fails with refresh_token_reused on the next
    // run (#5028). Replace the regular file with a symlink so the CLI follows
    // the live source. Safe to delete: target is always under the
    // Paperclip-managed company home, never the user's real ~/.codex.
    // Directories are left alone — `fs.unlink` would throw EISDIR on Unix
    // (and behave inconsistently on Windows). A directory at this path is not
    // a Paperclip-written stale copy and warrants operator inspection rather
    // than silent removal.
    if (existing.isDirectory()) return;
    await fs.unlink(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (await isExpectedSymlink(target, source)) return;

  await fs.unlink(target);
  await createExpectedSymlink(target, source);
}

async function acquireAuthLock(
  lockPath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<FileHandle | null> {
  await ensureParentDir(lockPath);
  const startedAt = Date.now();

  while (Date.now() - startedAt < AUTH_LOCK_TIMEOUT_MS) {
    try {
      return await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        await onLog(
          "stderr",
          `[paperclip] Warning: Could not acquire auth.json lock at "${lockPath}"; proceeding without rotated-token write-back.\n`,
        );
        return null;
      }
      await delay(AUTH_LOCK_RETRY_MS);
    }
  }

  await onLog(
    "stderr",
    `[paperclip] Warning: Timed out waiting for auth.json lock at "${lockPath}"; proceeding without rotated-token write-back.\n`,
  );
  return null;
}

async function releaseAuthLock(lockPath: string, handle: FileHandle): Promise<void> {
  await handle.close().catch(() => {});
  await fs.unlink(lockPath).catch(() => {});
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  await ensureParentDir(target);
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await fs.copyFile(source, tempPath);
    await fs.chmod(tempPath, 0o600).catch(() => {});
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function shouldWriteDetachedAuthBack(target: string, source: string): Promise<boolean> {
  const targetStat = await fs.stat(target);
  const sourceStat = await fs.stat(source).catch(() => null);
  return !sourceStat || targetStat.mtimeMs > sourceStat.mtimeMs;
}

async function writeBackDetachedAuthIfNewer(target: string, source: string): Promise<boolean> {
  if (!(await shouldWriteDetachedAuthBack(target, source))) return false;
  await copyFileAtomic(target, source);
  return true;
}

async function restoreSharedAuthJsonSymlink(
  target: string,
  source: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing || existing.isSymbolicLink() || existing.isDirectory()) {
    await ensureSymlink(target, source);
    return;
  }

  const lockPath = `${source}.lock`;
  const lock = await acquireAuthLock(lockPath, onLog);
  if (!lock) return;

  try {
    const current = await fs.lstat(target).catch(() => null);
    if (!current || current.isSymbolicLink() || current.isDirectory()) {
      await ensureSymlink(target, source);
      return;
    }

    const wroteBack = await writeBackDetachedAuthIfNewer(target, source);
    await ensureSymlink(target, source);
    if (wroteBack) {
      await onLog("stdout", `${RESTORED_AUTH_SYMLINK_MESSAGE}\n`);
    }
  } finally {
    await releaseAuthLock(lockPath, lock);
  }
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await fs.rm(target, { force: true });
  await fs.writeFile(target, JSON.stringify({ OPENAI_API_KEY: apiKey }), { mode: 0o600 });
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null } = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      const target = path.join(targetHome, name);
      const targetExists = await fs.lstat(target).then(() => true).catch(() => false);
      if (!(await pathExists(source)) && !targetExists) continue;
      if (name === "auth.json") {
        await restoreSharedAuthJsonSymlink(target, source, onLog);
      } else {
        await ensureSymlink(target, source);
      }
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }

  return targetHome;
}
