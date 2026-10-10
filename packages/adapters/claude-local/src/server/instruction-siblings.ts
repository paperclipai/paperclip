import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface InstructionSiblingFile {
  /** POSIX-style path relative to the directory that holds the entry instructions file. */
  relativePath: string;
  contents: string;
}

export const INSTRUCTION_SIBLING_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  /** Directory entries processed across the whole walk, hidden ones included. Each directory is still listed in full. */
  maxEntriesVisited: 2048,
} as const;

/** Name the prompt bundle gives to the entry instructions file. Siblings must not replace it. */
export const BUNDLE_ENTRY_FILE_NAME = "agent-instructions.md";

const byCodeUnit = (left: string, right: string) => (left < right ? -1 : 1);

/**
 * Collect the Markdown files that sit next to an agent's entry instructions file,
 * so they can travel to a remote execution target together with the entry file.
 * Reads regular `.md` files (extension matched case-insensitively). Silently skips
 * hidden entries, other files and the entry file itself. Skips, with a warning, symlinked
 * `.md` files, files over `maxFileBytes`, unreadable files and directories, and a top-level
 * file with the reserved bundle entry name. Descends at most
 * `maxDepth` directory levels. Stops the whole walk at `maxFiles`, `maxTotalBytes`
 * or `maxEntriesVisited`. Entries are walked and returned in code-unit order, so the
 * selected files and the prompt bundle key do not depend on the host locale.
 */
export async function readInstructionSiblingFiles(input: {
  entryFilePath: string;
  maxDepth: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<InstructionSiblingFile[]> {
  const { entryFilePath, maxDepth, onLog } = input;
  const rootDir = path.dirname(entryFilePath);
  const entryRelativePath = path.basename(entryFilePath);
  const { maxFiles, maxFileBytes, maxTotalBytes, maxEntriesVisited } = INSTRUCTION_SIBLING_LIMITS;
  const files: InstructionSiblingFile[] = [];
  let totalBytes = 0;
  let entriesVisited = 0;
  let truncated = false;

  const warn = (message: string) => onLog("stderr", `[paperclip] Warning: ${message}\n`);

  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (err) {
      await warn(
        `could not list instruction files in "${absoluteDir}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    entries.sort((left, right) => byCodeUnit(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      entriesVisited += 1;
      if (entriesVisited > maxEntriesVisited) {
        truncated = true;
        await warn(
          `instruction files from "${rootDir}" were truncated after ${maxEntriesVisited} directory entries for the remote target.`,
        );
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(relativePath, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (relativePath === entryRelativePath) continue;
      if (entry.isSymbolicLink()) {
        await warn(`instruction file "${relativePath}" was not sent to the remote target: symlinks are not followed.`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relativePath === BUNDLE_ENTRY_FILE_NAME) {
        await warn(`instruction file "${relativePath}" was not sent to the remote target: its name is reserved.`);
        continue;
      }
      const absolutePath = path.join(rootDir, relativePath);
      let contents: string;
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size > maxFileBytes) {
          await warn(`instruction file "${relativePath}" was not sent to the remote target: it is larger than ${maxFileBytes} bytes.`);
          continue;
        }
        contents = await fs.readFile(absolutePath, "utf-8");
      } catch (err) {
        await warn(
          `instruction file "${relativePath}" was not sent to the remote target: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const size = Buffer.byteLength(contents, "utf-8");
      if (files.length >= maxFiles || totalBytes + size > maxTotalBytes) {
        truncated = true;
        await warn(
          `instruction files from "${rootDir}" were truncated at ${files.length} files / ${totalBytes} bytes for the remote target.`,
        );
        return;
      }
      totalBytes += size;
      files.push({ relativePath, contents });
    }
  };

  await walk("", 0);
  files.sort((left, right) => byCodeUnit(left.relativePath, right.relativePath));
  return files;
}
