import fs from "node:fs/promises";
import path from "node:path";

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
