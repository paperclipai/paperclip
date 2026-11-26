import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Cleanup of a stopped, test-owned tree. Never follow links to dependencies
 * or external workspaces when making immutable bundle directories removable. */
export async function makeDirectoryTreeRemovable(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cleanup requires an owned directory, not a symlink");
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => makeDirectoryTreeRemovable(path.join(directory, entry.name))));
}
