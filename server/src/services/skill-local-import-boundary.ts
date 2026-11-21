import { promises as fs } from "node:fs";
import path from "node:path";
import { unprocessable } from "../errors.js";

function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Package caches and audit library copies (`__audit__`, which can hold a
 * restricted repository while an audit runs) have package-level provenance,
 * not local-import authority.
 */
export async function assertLocalImportOutsideSkillPackageCache(sourceRealPath: string, managedSkillsRoot: string) {
  const managedRoot = await fs.realpath(managedSkillsRoot).catch(() => null);
  if (!managedRoot) return;
  const reservedRoots = [path.join(managedRoot, "__packages__"), path.join(managedRoot, "__audit__")];
  const canonicalRoots = await Promise.all(reservedRoots.map(root => fs.realpath(root).catch(() => root)));
  // Also reject ancestors before a cache exists: a concurrent fill must not
  // become visible to a recursive import after its boundary check.
  if ([...reservedRoots, ...canonicalRoots].some(root => contains(root, sourceRealPath) || contains(sourceRealPath, root))) {
    throw unprocessable("Skill package caches cannot be imported as local sources. Fork the installed skill to retain its access restrictions.",
      { code: "skill_package_cache_import_denied" });
  }
}
