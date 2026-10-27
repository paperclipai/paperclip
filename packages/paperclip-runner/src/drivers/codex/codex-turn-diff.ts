export interface ParsedCodexTurnDiffFile {
  path: string;
  operation: "create" | "modify" | "delete" | "rename" | "mode_change";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  diff: string | null;
}

export interface CodexTurnDiffSummary {
  files: number;
  additions: number | null;
  deletions: number | null;
}

export function summarizeCodexTurnDiff(
  files: readonly Pick<ParsedCodexTurnDiffFile, "additions" | "deletions">[],
): CodexTurnDiffSummary {
  const unknown = files.some((file) => file.additions === null || file.deletions === null);
  return {
    files: files.length,
    additions: unknown ? null : files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: unknown ? null : files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}

const MAX_TURN_DIFF_FILES = 2_000;
const MAX_TURN_DIFF_CHARS_PER_FILE = 256 * 1024;

function gitDiffHunkCounts(line: string): { old: number; new: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isSafeInteger(oldStart) || !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(newStart) || !Number.isSafeInteger(newCount)
  ) return null;
  return { old: oldCount, new: newCount };
}

function gitDiffPath(value: string): string | null {
  let candidate = value.trim();
  if (candidate === "/dev/null") return null;
  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    try {
      candidate = JSON.parse(candidate) as string;
    } catch {
      return null;
    }
  }
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) candidate = candidate.slice(2);
  // Reject a native Windows drive path before slash normalization so the
  // workspace boundary is explicit for either separator spelling.
  if (/^[A-Za-z]:[\\/]/u.test(candidate)) return null;
  candidate = candidate.replaceAll("\\", "/");
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) candidate = candidate.slice(2);
  if (
    !candidate ||
    candidate.length > 1_024 ||
    candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /^[A-Za-z]:\//u.test(candidate) ||
    candidate.split("/").some((part) => part === ".." || part.length === 0)
  ) return null;
  return candidate;
}

/** Parse one complete Codex `turn/diff/updated` snapshot without consulting git or the live workspace. */
export function parseCodexTurnDiff(value: unknown): ParsedCodexTurnDiffFile[] {
  const patch = typeof value === "string" ? value : "";
  if (!patch.trim()) return [];
  const files: ParsedCodexTurnDiffFile[] = [];
  let current: {
    lines: string[];
    oldPath: string | null;
    newPath: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    additions: number;
    deletions: number;
    binary: boolean;
    modeChange: boolean;
    inHunk: boolean;
    oldHunkLinesRemaining: number | null;
    newHunkLinesRemaining: number | null;
    valid: boolean;
  } | null = null;

  const finish = () => {
    const incompleteHunk = current !== null && current.inHunk && (
      current.oldHunkLinesRemaining !== 0 || current.newHunkLinesRemaining !== 0
    );
    if (!current || !current.valid || incompleteHunk || files.length >= MAX_TURN_DIFF_FILES) return;
    const path = current.renameTo ?? current.newPath ?? current.oldPath;
    if (!path) return;
    const previousPath = current.renameFrom ?? (current.renameTo ? current.oldPath : null);
    const operation = current.renameTo && previousPath
      ? "rename"
      : current.oldPath === null
        ? "create"
        : current.newPath === null
          ? "delete"
          : current.modeChange && current.additions === 0 && current.deletions === 0
            ? "mode_change"
            : "modify";
    const completeDiff = `${current.lines.join("\n")}\n`;
    files.push({
      path,
      operation,
      previousPath,
      additions: current.binary ? null : current.additions,
      deletions: current.binary ? null : current.deletions,
      binary: current.binary,
      diff: current.binary ? null : completeDiff.slice(0, MAX_TURN_DIFF_CHARS_PER_FILE),
    });
  };

  for (const line of patch.split("\n")) {
    const hunkComplete = current !== null && current.inHunk &&
      current.oldHunkLinesRemaining === 0 && current.newHunkLinesRemaining === 0;
    const header = line.startsWith("diff --git ")
      ? line.match(/^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/)
      : null;
    if ((!current || !current.inHunk || hunkComplete) && header) {
      finish();
      current = {
        lines: [line],
        oldPath: gitDiffPath(header[1] ?? ""),
        newPath: gitDiffPath(header[2] ?? ""),
        renameFrom: null,
        renameTo: null,
        additions: 0,
        deletions: 0,
        binary: false,
        modeChange: false,
        inHunk: false,
        oldHunkLinesRemaining: null,
        newHunkLinesRemaining: null,
        valid: true,
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (!current.inHunk && line.startsWith("diff --git ") && !header) {
      current.valid = false;
      continue;
    }
    if (!current.inHunk && line.startsWith("--- ")) current.oldPath = gitDiffPath(line.slice(4));
    else if (!current.inHunk && line.startsWith("+++ ")) current.newPath = gitDiffPath(line.slice(4));
    else if (!current.inHunk && line.startsWith("rename from ")) current.renameFrom = gitDiffPath(line.slice(12));
    else if (!current.inHunk && line.startsWith("rename to ")) current.renameTo = gitDiffPath(line.slice(10));
    else if (!current.inHunk && (line.startsWith("old mode ") || line.startsWith("new mode "))) current.modeChange = true;
    else if (!current.inHunk && (line.startsWith("Binary files ") || line === "GIT binary patch")) current.binary = true;
    else if ((!current.inHunk || hunkComplete) && line.startsWith("@@")) {
      const counts = gitDiffHunkCounts(line);
      if (!counts) {
        current.valid = false;
        current.inHunk = true;
        current.oldHunkLinesRemaining = null;
        current.newHunkLinesRemaining = null;
        continue;
      }
      current.inHunk = true;
      current.oldHunkLinesRemaining = counts.old;
      current.newHunkLinesRemaining = counts.new;
    } else if (current.inHunk) {
      if (!current.valid || line === "\\ No newline at end of file") {
        continue;
      } else if (line.startsWith("+")) {
        if (current.newHunkLinesRemaining === null || current.newHunkLinesRemaining === 0) {
          current.valid = false;
          current.oldHunkLinesRemaining = null;
          current.newHunkLinesRemaining = null;
          continue;
        }
        current.additions += 1;
        current.newHunkLinesRemaining -= 1;
      } else if (line.startsWith("-")) {
        if (current.oldHunkLinesRemaining === null || current.oldHunkLinesRemaining === 0) {
          current.valid = false;
          current.oldHunkLinesRemaining = null;
          current.newHunkLinesRemaining = null;
          continue;
        }
        current.deletions += 1;
        current.oldHunkLinesRemaining -= 1;
      } else if (line.startsWith(" ")) {
        if (
          current.oldHunkLinesRemaining === null || current.oldHunkLinesRemaining === 0 ||
          current.newHunkLinesRemaining === null || current.newHunkLinesRemaining === 0
        ) {
          current.valid = false;
          current.oldHunkLinesRemaining = null;
          current.newHunkLinesRemaining = null;
          continue;
        }
        current.oldHunkLinesRemaining -= 1;
        current.newHunkLinesRemaining -= 1;
      } else if (line.startsWith("@@")) {
        current.valid = false;
        current.oldHunkLinesRemaining = null;
        current.newHunkLinesRemaining = null;
        continue;
      } else if (!hunkComplete) {
        current.valid = false;
        current.oldHunkLinesRemaining = null;
        current.newHunkLinesRemaining = null;
        continue;
      } else if (hunkComplete && line.startsWith("diff --git ")) {
        current.valid = false;
        current.oldHunkLinesRemaining = null;
        current.newHunkLinesRemaining = null;
        continue;
      }
    }
  }
  finish();
  return files;
}
