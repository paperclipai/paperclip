import fs from "node:fs/promises";
import path from "node:path";
import type { LocalProcessSandboxPath } from "@paperclipai/adapter-utils/local-process-sandbox";

export async function resolveCodexLocalSandboxManagedPaths(input: {
  effectiveCodexHome: string;
  sharedCodexHome: string;
  filesystemScope: "workspace" | null;
}): Promise<LocalProcessSandboxPath[]> {
  const managedPaths: LocalProcessSandboxPath[] = [
    { path: input.effectiveCodexHome, access: "rw" },
  ];
  if (input.filesystemScope !== "workspace") return managedPaths;

  const managedAuthPath = path.join(input.effectiveCodexHome, "auth.json");
  const managedAuthEntry = await fs.lstat(managedAuthPath).catch(() => null);
  if (!managedAuthEntry?.isSymbolicLink()) return managedPaths;

  // The managed home is writable by the agent. Mount only Paperclip's known
  // shared credential target, not an arbitrary symlink created in that home.
  const sharedAuthPath = path.join(input.sharedCodexHome, "auth.json");
  const [managedAuthTarget, sharedAuthTarget] = await Promise.all([
    fs.realpath(managedAuthPath).catch(() => null),
    fs.realpath(sharedAuthPath).catch(() => null),
  ]);
  if (!managedAuthTarget || managedAuthTarget !== sharedAuthTarget) return managedPaths;

  managedPaths.push({ path: managedAuthTarget, access: "ro" });

  // If the shared auth.json path itself goes through a symlink, the managed
  // link still names that path, which the fresh root would otherwise lack.
  // Bind it only when the managed link points exactly at the known shared path.
  const resolvedSharedAuthPath = path.resolve(sharedAuthPath);
  if (resolvedSharedAuthPath !== managedAuthTarget) {
    const managedAuthLink = await fs.readlink(managedAuthPath).catch(() => null);
    if (
      managedAuthLink &&
      path.resolve(path.dirname(managedAuthPath), managedAuthLink) === resolvedSharedAuthPath
    ) {
      managedPaths.push({ path: resolvedSharedAuthPath, access: "ro" });
    }
  }
  return managedPaths;
}
