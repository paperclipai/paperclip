import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSafePackageRelativeEntrypoint } from "@paperclipai/shared";

export type PluginEntrypointKind = "file" | "directory" | "any";

export { isSafePackageRelativeEntrypoint };

export function isPathWithinDirectory(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolvePackageRelativeEntrypoint(packageRoot: string, entrypoint: string): string | null {
  if (!isSafePackageRelativeEntrypoint(entrypoint)) return null;

  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedEntrypoint = path.resolve(resolvedPackageRoot, entrypoint);
  if (!isPathWithinDirectory(resolvedPackageRoot, resolvedEntrypoint)) return null;

  return resolvedEntrypoint;
}

export function resolveExistingPackageEntrypoint(
  packageRoot: string,
  entrypoint: string,
  expectedKind: PluginEntrypointKind = "any",
): string | null {
  const resolvedEntrypoint = resolvePackageRelativeEntrypoint(packageRoot, entrypoint);
  if (!resolvedEntrypoint || !existsSync(resolvedEntrypoint)) return null;

  let entrypointStat;
  let realPackageRoot: string;
  let realEntrypoint: string;
  try {
    entrypointStat = statSync(resolvedEntrypoint);
    realPackageRoot = realpathSync(path.resolve(packageRoot));
    realEntrypoint = realpathSync(resolvedEntrypoint);
  } catch {
    return null;
  }

  if (expectedKind === "file" && !entrypointStat.isFile()) return null;
  if (expectedKind === "directory" && !entrypointStat.isDirectory()) return null;
  if (!isPathWithinDirectory(realPackageRoot, realEntrypoint)) return null;

  return resolvedEntrypoint;
}
