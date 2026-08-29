export interface ParsedCodexTurnDiffFile {
  path: string;
  operation: "create" | "modify" | "delete" | "rename" | "mode_change";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  diff: string | null;
}

const MAX_TURN_DIFF_FILES = 2_000;
const MAX_TURN_DIFF_CHARS_PER_FILE = 256 * 1024;

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
  } | null = null;

  const finish = () => {
    if (!current || files.length >= MAX_TURN_DIFF_FILES) return;
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
    if (line.startsWith("diff --git ")) {
      finish();
      const header = line.match(/^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/);
      current = {
        lines: [line],
        oldPath: header ? gitDiffPath(header[1] ?? "") : null,
        newPath: header ? gitDiffPath(header[2] ?? "") : null,
        renameFrom: null,
        renameTo: null,
        additions: 0,
        deletions: 0,
        binary: false,
        modeChange: false,
        inHunk: false,
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (!current.inHunk && line.startsWith("--- ")) current.oldPath = gitDiffPath(line.slice(4));
    else if (!current.inHunk && line.startsWith("+++ ")) current.newPath = gitDiffPath(line.slice(4));
    else if (!current.inHunk && line.startsWith("rename from ")) current.renameFrom = gitDiffPath(line.slice(12));
    else if (!current.inHunk && line.startsWith("rename to ")) current.renameTo = gitDiffPath(line.slice(10));
    else if (!current.inHunk && (line.startsWith("old mode ") || line.startsWith("new mode "))) current.modeChange = true;
    else if (!current.inHunk && (line.startsWith("Binary files ") || line === "GIT binary patch")) current.binary = true;
    else if (line.startsWith("@@")) current.inHunk = true;
    else if (current.inHunk && line.startsWith("+")) current.additions += 1;
    else if (current.inHunk && line.startsWith("-")) current.deletions += 1;
  }
  finish();
  return files;
}
