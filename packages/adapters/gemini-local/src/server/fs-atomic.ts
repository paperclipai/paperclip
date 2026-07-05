import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Atomic file writer + in-process keyed mutex for per-agent MCP config files.
 *
 * Up to 20 concurrent same-agent runs can target the same shared workspace
 * settings file. A plain truncate-then-write (`fs.writeFile`) lets a launching
 * CLI read a torn/empty file; a read-modify-write additionally races two
 * merges. `atomicWriteFile` writes to a temp sibling (0600) then renames over
 * the target (atomic replace); `withFileLock` serializes read-modify-write
 * sequences that touch the same path within this process.
 */

/** Write `data` to `target` atomically: temp sibling (0600) then rename. */
export async function atomicWriteFile(target: string, data: string): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Serialize `fn` against other calls sharing the same `key` in this process. */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = (locks.get(key) ?? Promise.resolve()).catch(() => undefined);
  const next = prior.then(fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}
