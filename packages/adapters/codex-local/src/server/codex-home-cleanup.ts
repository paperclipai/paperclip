import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_SYNC_ALLOWLIST } from "./codex-home.js";

const lstatOrNull = (target: string) => fs.lstat(target).catch((error) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
});

/**
 * Makes a reused generated home safe to seed and stage again. A run can rewrite
 * its own home (a sandboxed Codex mounts it read-write), so a later run must not
 * trust what it left at the entries the host writes or reads on its behalf: a
 * symlink or hard link there would make seeding (`ensureCopiedFile`,
 * `writeManagedCodexMcpConfig`, skill injection) write through to a host file,
 * or make staging upload one. Anything at those entries other than a private
 * regular file (or, for `skills`, a real directory) is removed. Inside `skills`,
 * every direct entry that is not a real directory is removed too: staging
 * follows a top-level skill link wherever it points, and skill injection later
 * in the run recreates the links it wants. Seeding then recreates the expected
 * entries, including the credential link. Returns the removed entry names.
 */
export async function removeUnsafeCodexHomeEntries(home: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of CODEX_SYNC_ALLOWLIST) {
    if (name === "skills") continue;
    const target = path.join(home, name);
    const stat = await lstatOrNull(target);
    if (!stat || (stat.isFile() && stat.nlink === 1)) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(name);
  }
  const skills = path.join(home, "skills");
  const skillsStat = await lstatOrNull(skills);
  if (skillsStat && !skillsStat.isDirectory()) {
    await fs.rm(skills, { force: true });
    removed.push("skills");
  } else if (skillsStat) {
    for (const entry of await fs.readdir(skills)) {
      const target = path.join(skills, entry);
      const stat = await lstatOrNull(target);
      if (!stat || stat.isDirectory()) continue;
      await fs.rm(target, { force: true });
      removed.push(`skills/${entry}`);
    }
  }
  return removed;
}
