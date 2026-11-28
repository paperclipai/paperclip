import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function hasPersistedSource(value: Buffer | undefined): boolean {
  return Boolean(value && value.length > 0);
}

/** A Stop boundary is valid only when both facts hold at the same observation. */
export function isSavedSourceCheckpoint(
  active: boolean,
  value: Buffer | undefined,
): boolean {
  return active && hasPersistedSource(value);
}

const SOURCE_FILE = "slugify.py";
const SOURCE_SEARCH_DEPTH = 2;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv"]);

/**
 * Reads the slugify source the agent saved in the task workspace. The brief
 * asks for `slugify.py` "in the project workspace", not at its root, so agents
 * may reasonably create a project folder. Prefer the root copy, then the
 * shallowest (alphabetically first) copy in a bounded set of subfolders.
 */
export async function readWorkspaceSource(
  workspaceRoot: string,
): Promise<Buffer | undefined> {
  let level = [workspaceRoot];
  for (let depth = 0; depth <= SOURCE_SEARCH_DEPTH && level.length; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      const source = await readFile(path.join(directory, SOURCE_FILE)).catch(() => undefined);
      if (source) return source;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      next.push(...entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name))
        .map((entry) => entry.name)
        .sort()
        .map((name) => path.join(directory, name)));
    }
    level = next;
  }
  return undefined;
}
