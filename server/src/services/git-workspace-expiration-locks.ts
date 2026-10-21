import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type GitExpirationLockLocation = { root: string; relativePath: string; checkout: string | null };

function marker(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_expiration_lock_token");
  return Buffer.from(`paperclip-git-expiration-lock-v1:${token}\n`);
}

async function lockPaths(location: GitExpirationLockLocation, token: string, create: boolean) {
  const segments = location.relativePath.split(path.sep);
  if (path.isAbsolute(location.relativePath) || segments.some(segment => !segment || segment === "." || segment === "..")) throw new Error("unsafe_expiration_lock_path");
  const root = await fs.lstat(location.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!root) {
    if (create) throw new Error("missing_expiration_lock_root");
    return null;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe_expiration_lock_path");
  let parent = await fs.realpath(location.root);
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    if (create) await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_expiration_lock_path");
  }
  const digest = createHash("sha256").update(location.relativePath).digest("hex").slice(0, 16);
  return { lock: path.join(parent, segments.at(-1)!), temporary: path.join(parent, `.paperclip-expiration-${token}-${digest}`) };
}

async function removeOwnedFile(target: string, expected: Buffer, allowPartial: boolean) {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > expected.length || stat.nlink > 2) throw new Error("git_expiration_lock_conflict");
    const bytes = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const actual = bytes.subarray(0, bytesRead);
    if (actual.length !== stat.size) throw new Error("git_expiration_lock_conflict");
    if (!(allowPartial && stat.nlink === 1 ? actual.equals(expected.subarray(0, actual.length)) : actual.equals(expected))) {
      throw new Error("git_expiration_lock_conflict");
    }
    const current = await fs.lstat(target);
    if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isFile()) throw new Error("git_expiration_lock_conflict");
    await fs.unlink(target);
  } finally { await handle.close(); }
}

export async function recoverGitExpirationLocks(locations: GitExpirationLockLocation[], token: string) {
  const expected = marker(token);
  for (const location of locations) {
    const paths = await lockPaths(location, token, false);
    if (!paths) continue;
    await removeOwnedFile(paths.temporary, expected, true);
    await removeOwnedFile(paths.lock, expected, false);
  }
}

export async function acquireGitExpirationLocks(locations: GitExpirationLockLocation[], token: string) {
  const expected = marker(token);
  const owned: GitExpirationLockLocation[] = [];
  try {
    for (const location of locations) {
      const paths = (await lockPaths(location, token, true))!;
      const handle = await fs.open(paths.temporary, "wx", 0o600);
      owned.push(location);
      try { await handle.writeFile(expected); await handle.sync(); } finally { await handle.close(); }
      await fs.link(paths.temporary, paths.lock);
      await fs.unlink(paths.temporary);
    }
  } catch (error) {
    await recoverGitExpirationLocks(owned, token);
    throw error;
  }
  return { release: () => recoverGitExpirationLocks(owned, token) };
}
