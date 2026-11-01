import fs from "node:fs";
import path from "node:path";

/**
 * Removes a per-worker test home at worker exit.
 *
 * A plain recursive `rmSync` is not enough: a native session materializes its
 * runtime-context bundles under the instance root and makes every directory
 * in them read-only (`makeDirectoriesReadOnly` in
 * services/native-runtime/runtime-context.ts), and a run that is still
 * finishing when the worker exits can leave such a bundle under the worker's
 * home. Removing a file inside a read-only directory fails with `EACCES`,
 * Vitest reports it as an unhandled error, and the shard fails after every
 * test passed. So on a permission error every directory in the tree is made
 * writable first and the removal is tried once more.
 */
export function removeTestHome(home: string): void {
  const options = { recursive: true, force: true, maxRetries: 8, retryDelay: 50 } as const;
  try {
    fs.rmSync(home, options);
  } catch (error) {
    const permissionError = isPermissionError(error);
    if (!permissionError && (error as NodeJS.ErrnoException | null)?.code !== "ENOTEMPTY") throw error;
    const restored = makeDirectoriesWritable(home);
    if (!permissionError && !restored) throw error;
    fs.rmSync(home, options);
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function makeDirectoriesWritable(directory: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  // Owner read, write and search: enough to list and unlink the children.
  // A symlink is not followed, so nothing outside the home is touched.
  let restored = false;
  if ((stat.mode & 0o700) !== 0o700) {
    try {
      fs.chmodSync(directory, stat.mode | 0o700);
      restored = true;
    } catch {
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return restored;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && makeDirectoriesWritable(path.join(directory, entry.name))) restored = true;
  }
  return restored;
}
