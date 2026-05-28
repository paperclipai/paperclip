import fs from "node:fs/promises";
import path from "node:path";

export interface InstructionFragment {
  source: string;
  contents: string;
}

export interface LoadInstructionsParams {
  cwd: string;
  instructionsFilePath?: string | null;
  bundleFilenames?: string[];
}

const DEFAULT_BUNDLE_FILENAMES = ["AGENTS.md", "HEARTBEAT.md"];

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw err;
  }
}

/**
 * Load AGENTS.md / HEARTBEAT.md and an optional explicit instructions file
 * into a list of fragments, skipping anything missing. The order is
 * deterministic so the assembled system prompt is stable across runs.
 */
export async function loadInstructionFragments(
  params: LoadInstructionsParams,
): Promise<InstructionFragment[]> {
  const fragments: InstructionFragment[] = [];
  const seen = new Set<string>();
  const explicit = params.instructionsFilePath?.trim();

  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      const contents = await tryReadFile(resolved);
      if (contents !== null && contents.trim().length > 0) {
        fragments.push({ source: resolved, contents });
      }
    }
  }

  const filenames = params.bundleFilenames ?? DEFAULT_BUNDLE_FILENAMES;
  for (const filename of filenames) {
    const resolved = path.resolve(params.cwd, filename);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const contents = await tryReadFile(resolved);
    if (contents !== null && contents.trim().length > 0) {
      fragments.push({ source: resolved, contents });
    }
  }

  return fragments;
}

export function joinInstructionFragments(
  fragments: InstructionFragment[],
): string {
  if (fragments.length === 0) return "";
  return fragments
    .map((f) => `<!-- source: ${f.source} -->\n${f.contents.trimEnd()}`)
    .join("\n\n---\n\n");
}
