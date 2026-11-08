import fs from "node:fs/promises";
import path from "node:path";

export function localWorkspaceSourcePaths(workspace: { cwd?: string | null; providerRef?: string | null }): string[] {
  return [...new Set([workspace.cwd, workspace.providerRef].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export async function canonicalRepositoryRoot(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalRepositoryRoot(parent), path.basename(absolute));
  }
}
