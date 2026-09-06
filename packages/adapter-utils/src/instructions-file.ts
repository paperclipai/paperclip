import { stat, readFile } from "node:fs/promises";

export type InstructionsFileResult =
  | { ok: true; contents: string }
  | { ok: false; error: "EISDIR"; path: string }
  | { ok: false; error: "ENOENT"; path: string }
  | { ok: false; error: "OTHER"; path: string; reason: string };

export function instructionsFailureMessage(dirPath: string): string {
  return (
    `instructionsFilePath "${dirPath}" is a directory. ` +
    `Set it to a real file (e.g. .../AGENTS.md) or configure instructionsRootPath + instructionsEntryFile.`
  );
}

/**
 * Safely read an instructions file, distinguishing EISDIR (fail-fast) from
 * ENOENT / other errors (warn-and-continue).
 *
 * Callers should throw on `error: "EISDIR"` and warn+continue on anything else.
 */
export async function readInstructionsFileSafe(
  resolvedPath: string,
): Promise<InstructionsFileResult> {
  try {
    const stats = await stat(resolvedPath);
    if (stats.isDirectory()) {
      return { ok: false, error: "EISDIR", path: resolvedPath };
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: "ENOENT", path: resolvedPath };
    }
    // stat itself failed for another reason (EACCES etc.) — treat as OTHER
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "OTHER", path: resolvedPath, reason };
  }

  try {
    const contents = await readFile(resolvedPath, "utf8");
    return { ok: true, contents };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EISDIR") {
      return { ok: false, error: "EISDIR", path: resolvedPath };
    }
    if (code === "ENOENT") {
      return { ok: false, error: "ENOENT", path: resolvedPath };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "OTHER", path: resolvedPath, reason };
  }
}
