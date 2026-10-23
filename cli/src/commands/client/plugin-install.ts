import path from "node:path";
import { existsSync } from "node:fs";
import { parseNpmPackageSpec } from "@paperclipai/shared";

interface PluginInstallRequest {
  packageName: string;
  version?: string;
  isLocalPath: boolean;
}

function expandHomePath(packageArg: string): string {
  if (!packageArg.startsWith("~")) return packageArg;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.resolve(home, packageArg.slice(1).replace(/^[\\/]/, ""));
}

function hasLocalPathSyntax(packageArg: string): boolean {
  return (
    path.isAbsolute(packageArg) ||
    packageArg.startsWith("./") ||
    packageArg.startsWith("../") ||
    packageArg.startsWith("~") ||
    packageArg.startsWith(".\\") ||
    packageArg.startsWith("..\\")
  );
}

function isExistingRelativePath(
  packageArg: string,
  cwd: string,
  pathExists: (targetPath: string) => boolean,
): boolean {
  if (packageArg.trim() === "") return false;
  if (hasLocalPathSyntax(packageArg)) return false;
  return pathExists(path.resolve(cwd, packageArg));
}

/**
 * Resolve a local path argument to an absolute path so the server can find the
 * plugin on disk regardless of where the user ran the CLI.
 */
function resolvePackageArg(packageArg: string, isLocal: boolean, cwd = process.cwd()): string {
  if (!isLocal) return packageArg;
  if (path.isAbsolute(packageArg)) return packageArg;
  if (packageArg.startsWith("~")) return expandHomePath(packageArg);
  return path.resolve(cwd, packageArg);
}

export function buildPluginInstallRequest(
  packageArg: string,
  opts: { local?: boolean; version?: string } = {},
  deps: { cwd?: string; existsSync?: (targetPath: string) => boolean } = {},
): PluginInstallRequest {
  const cwd = deps.cwd ?? process.cwd();
  const pathExists = deps.existsSync ?? existsSync;
  const isLocal =
    opts.local ||
    hasLocalPathSyntax(packageArg) ||
    (opts.version ? false : isExistingRelativePath(packageArg, cwd, pathExists));

  if (isLocal && opts.version) {
    throw new Error("--version is only supported for npm package installs, not local plugin paths.");
  }

  const npmSpec = isLocal
    ? { packageName: packageArg, version: undefined }
    : parseNpmPackageSpec(packageArg, opts.version);

  return {
    packageName: resolvePackageArg(npmSpec.packageName, Boolean(isLocal), cwd),
    version: npmSpec.version,
    isLocalPath: Boolean(isLocal),
  };
}
