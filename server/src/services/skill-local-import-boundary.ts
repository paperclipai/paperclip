import { promises as fs } from "node:fs";
import path from "node:path";
import { unprocessable } from "../errors.js";

function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Package caches have package-level provenance, not local-import authority. */
export async function assertLocalImportOutsideSkillPackageCache(sourceRealPath: string, managedSkillsRoot: string) {
  const managedRoot = await fs.realpath(managedSkillsRoot).catch(() => null);
  if (!managedRoot) return;
  const reservedRoot = path.join(managedRoot, "__packages__");
  const canonicalRoot = await fs.realpath(reservedRoot).catch(() => reservedRoot);
  // Also reject ancestors before a cache exists: a concurrent fill must not
  // become visible to a recursive import after its boundary check.
  if ([reservedRoot, canonicalRoot].some(root => contains(root, sourceRealPath) || contains(sourceRealPath, root))) {
    throw unprocessable("Skill package caches cannot be imported as local sources. Fork the installed skill to retain its access restrictions.",
      { code: "skill_package_cache_import_denied" });
  }
}
