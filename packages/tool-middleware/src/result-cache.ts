/**
 * Result cache — disk-based dedup cache for tool call results.
 *
 * Key: (command_hash, cwd, env_subset, git_SHA)
 * TTL: 60s for volatile resources, 300s for stable resources.
 *
 * Uses a flat JSON file per cache key in the cache directory.
 * Safe for concurrent use by multiple agents — writes are atomic (tmp+rename).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CacheEntry, CacheKey, ToolResultSummary } from "./types.js";

/** Volatile tools (short TTL): frequently-changing resources. */
const VOLATILE_PREFIXES = ["kubectl get", "git status", "git diff", "git log", "docker ps", "ps aux", "df ", "du "];

/** Default TTLs in milliseconds. */
const VOLATILE_TTL_MS = 60_000;
const STABLE_TTL_MS = 300_000;

function isVolatile(command: string): boolean {
  const lower = command.toLowerCase();
  return VOLATILE_PREFIXES.some((p) => lower.startsWith(p));
}

/** Compute cache TTL for a command. */
export function resolveTtlMs(command: string): number {
  return isVolatile(command) ? VOLATILE_TTL_MS : STABLE_TTL_MS;
}

/** Compute a cache key hash from key material. */
export function computeCacheKeyHash(key: CacheKey): string {
  const raw = JSON.stringify({ commandHash: key.commandHash, cwd: key.cwd, gitSha: key.gitSha });
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/** Compute a hash for a command string. */
export function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex").slice(0, 16);
}

function cacheFilePath(cacheDir: string, keyHash: string): string {
  return path.join(cacheDir, `${keyHash}.json`);
}

/** Read a cache entry, returning null if missing or expired. */
export async function readCache(
  key: CacheKey,
  cacheDir: string,
): Promise<ToolResultSummary | null> {
  const keyHash = computeCacheKeyHash(key);
  const filePath = cacheFilePath(cacheDir, keyHash);

  let entry: CacheEntry;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }

  if (Date.now() > entry.storedAt + entry.ttlMs) {
    // Expired — delete and return null
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore
    }
    return null;
  }

  return entry.summary;
}

/** Write a result to the cache. */
export async function writeCache(
  key: CacheKey,
  summary: ToolResultSummary,
  ttlMs: number,
  cacheDir: string,
): Promise<void> {
  const keyHash = computeCacheKeyHash(key);
  const filePath = cacheFilePath(cacheDir, keyHash);
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  const entry: CacheEntry = { key, summary, storedAt: Date.now(), ttlMs };

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(entry), "utf8");
  // Atomic rename
  await fs.rename(tmpPath, filePath);
}

/** Get the current git SHA from the cwd (returns empty string on failure). */
export async function getCurrentGitSha(cwd: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
      timeout: 2000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Build a CacheKey for a Bash command. */
export async function buildCacheKey(command: string, cwd: string): Promise<CacheKey> {
  const commandHash = hashCommand(command);
  const gitSha = await getCurrentGitSha(cwd);
  return { commandHash, cwd, gitSha };
}
