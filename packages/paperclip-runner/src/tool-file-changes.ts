import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * One file touched by a single edit tool call, carried on the canonical
 * `paperclip.tool.execution.v1` payload so the edit row can show its own diff.
 * Paths are workspace-relative; the patch is bounded per file and per call.
 */
export interface ToolFileChange {
  path: string;
  operation: "create" | "modify" | "delete" | "rename";
  previousPath: string | null;
  additions: number;
  deletions: number;
  diff: string | null;
  diffTruncated: boolean;
}

export const MAX_TOOL_FILE_CHANGES = 32;
/** UTF-8 bytes of one file's patch (also within the schema's 32768-character bound). */
export const MAX_TOOL_FILE_DIFF_BYTES = 32 * 1024;
/**
 * Serialized JSON bytes of all patches in one edit call. The ACPX sidecar frame
 * is 128 KiB including up to 64 KiB of tool output, so patches stay well below
 * the remainder; a file over budget keeps its counts and drops only its patch.
 */
export const MAX_TOOL_CALL_DIFF_BYTES = 48 * 1024;

function serializedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function withinCallBudget(files: ToolFileChange[]): ToolFileChange[] {
  let budget = MAX_TOOL_CALL_DIFF_BYTES;
  return files.map((file) => {
    const size = file.diff === null ? 0 : serializedBytes(file.diff);
    if (size > budget) return { ...file, diff: null, diffTruncated: true };
    budget -= size;
    return file;
  });
}

/** Cut a patch to at most `maxBytes` UTF-8 bytes, at the last whole line. */
function boundedPatch(diff: string, maxBytes: number): { diff: string; truncated: boolean } {
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= maxBytes) return { diff, truncated: false };
  const prefix = bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  const cut = prefix.lastIndexOf("\n");
  return { diff: cut > 0 ? prefix.slice(0, cut) : prefix, truncated: true };
}

const MAX_LCS_CELLS = 4_000_000;

/** Workspace roots an absolute provider path may be relative to (e.g. a path and its realpath). */
export type WorkspaceRoots = string | readonly string[] | undefined;

/** A working directory and its resolved realpath, for providers that report either. */
export function workspaceRootsFor(directory: string | null | undefined): string[] {
  if (!directory) return [];
  try {
    const resolved = realpathSync(directory);
    return resolved === directory ? [directory] : [directory, resolved];
  } catch {
    return [directory];
  }
}

function relativeWorkspacePath(value: unknown, workingDirectory: WorkspaceRoots): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let candidate = value.trim().replace(/^file:\/\//, "").replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(candidate) || candidate.startsWith("/")) {
    const roots = typeof workingDirectory === "string" ? [workingDirectory] : workingDirectory ?? [];
    const absolute = path.posix.normalize(candidate);
    const relative = roots
      .map((root) => path.posix.relative(root.replaceAll("\\", "/").replace(/\/+$/, ""), absolute))
      .find((value) => value && value !== ".." && !value.startsWith("../") && !path.posix.isAbsolute(value));
    if (!relative) return null;
    candidate = relative;
  }
  candidate = path.posix.normalize(candidate);
  if (
    !candidate || candidate === "." || candidate.length > 1_024 ||
    candidate.startsWith("/") || candidate.split("/").includes("..")
  ) return null;
  return candidate;
}

/** Bound a unified diff at a line boundary, keeping counts from the full patch. */
export function boundedToolFileChange(change: Omit<ToolFileChange, "diffTruncated" | "additions" | "deletions"> & {
  additions?: number;
  deletions?: number;
}): ToolFileChange {
  const diff = change.diff ?? null;
  let additions = change.additions ?? 0;
  let deletions = change.deletions ?? 0;
  if (diff !== null && change.additions === undefined && change.deletions === undefined) {
    // `---`/`+++` are file headers only before a hunk; inside one they are
    // changed lines such as a removed `-- comment`.
    let inHunk = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) inHunk = false;
      else if (line.startsWith("@@")) inHunk = true;
      else if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue;
      else if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  const bounded = diff === null ? null : boundedPatch(diff, MAX_TOOL_FILE_DIFF_BYTES);
  return { ...change, additions, deletions, diff: bounded?.diff ?? null, diffTruncated: bounded?.truncated ?? false };
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Unified hunk for one old/new text pair (an ACP `diff` content block). Uses a
 * bounded LCS; very large blocks fall back to a whole-block replacement.
 */
export function unifiedHunkFromTexts(oldText: string | null, newText: string, newStart = 1): string {
  const before = splitLines(oldText ?? "");
  const after = splitLines(newText);
  const rows: string[] = [];
  if (before.length * after.length > MAX_LCS_CELLS) {
    for (const line of before) rows.push(`-${line}`);
    for (const line of after) rows.push(`+${line}`);
  } else {
    const n = before.length;
    const m = after.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] = before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && before[i] === after[j]) {
        rows.push(` ${before[i]}`);
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
        rows.push(`-${before[i]}`);
        i += 1;
      } else {
        rows.push(`+${after[j]}`);
        j += 1;
      }
    }
  }
  const start = Math.max(newStart, 1);
  const oldStart = before.length === 0 ? 0 : start;
  const newHeaderStart = after.length === 0 ? 0 : start;
  return [`@@ -${oldStart},${before.length} +${newHeaderStart},${after.length} @@`, ...rows].join("\n");
}

/**
 * File changes from ACP tool content (`{ type: "diff", path, oldText, newText }`).
 * Several blocks for one path (one per hunk after Claude's PostToolUse update)
 * join into one patch. Paths outside the workspace are dropped.
 */
export function toolFileChangesFromAcpContent(
  content: unknown,
  locations: unknown,
  workingDirectory: WorkspaceRoots,
): ToolFileChange[] | null {
  if (!Array.isArray(content)) return null;
  const lineByPath = new Map<string, number[]>();
  if (Array.isArray(locations)) {
    for (const value of locations) {
      if (!value || typeof value !== "object") continue;
      const location = value as Record<string, unknown>;
      const filePath = relativeWorkspacePath(location.path, workingDirectory);
      if (filePath && typeof location.line === "number" && Number.isSafeInteger(location.line)) {
        lineByPath.set(filePath, [...(lineByPath.get(filePath) ?? []), location.line]);
      }
    }
  }
  const byPath = new Map<string, { hunks: string[]; created: boolean }>();
  let blocks = 0;
  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    if (block.type !== "diff" || typeof block.newText !== "string") continue;
    const filePath = relativeWorkspacePath(block.path, workingDirectory);
    if (!filePath) continue;
    const oldText = typeof block.oldText === "string" ? block.oldText : null;
    const entry = byPath.get(filePath) ?? { hunks: [], created: true };
    const start = lineByPath.get(filePath)?.[entry.hunks.length] ?? 1;
    entry.hunks.push(unifiedHunkFromTexts(oldText, block.newText, start));
    entry.created &&= oldText === null;
    byPath.set(filePath, entry);
    blocks += 1;
    if (blocks >= 256) break;
  }
  if (byPath.size === 0) return null;
  return withinCallBudget([...byPath.entries()].slice(0, MAX_TOOL_FILE_CHANGES).map(([filePath, entry]) =>
    boundedToolFileChange({
      path: filePath,
      operation: entry.created ? "create" : "modify",
      previousPath: null,
      diff: `${entry.hunks.join("\n")}\n`,
    })));
}

/** File changes from a Codex `fileChange` item's `changes[]` (`{ path, kind, diff }`). */
export function toolFileChangesFromCodexChanges(
  changes: unknown,
  workingDirectory: WorkspaceRoots,
): ToolFileChange[] | null {
  if (!Array.isArray(changes)) return null;
  const files = changes.slice(0, MAX_TOOL_FILE_CHANGES).flatMap((value): ToolFileChange[] => {
    if (!value || typeof value !== "object") return [];
    const change = value as Record<string, unknown>;
    const filePath = relativeWorkspacePath(change.path, workingDirectory);
    if (!filePath) return [];
    const kind = change.kind && typeof change.kind === "object" ? change.kind as Record<string, unknown> : {};
    const kindText = (typeof change.kind === "string" ? change.kind : typeof kind.type === "string" ? kind.type : "update").toLowerCase();
    const movePath = relativeWorkspacePath(kind.move_path ?? kind.movePath, workingDirectory);
    const rawDiff = typeof change.diff === "string" ? change.diff : null;
    const operation: ToolFileChange["operation"] = movePath
      ? "rename"
      : kindText.includes("add") ? "create" : kindText.includes("delete") ? "delete" : "modify";
    // Codex reports a created file's full content and a deleted file's prior
    // content rather than a patch. Present both as a one-sided hunk.
    const diff = rawDiff === null
      ? null
      : (operation === "create" || operation === "delete") && !/^@@ /m.test(rawDiff)
        ? `${operation === "create" ? unifiedHunkFromTexts(null, rawDiff) : unifiedHunkFromTexts(rawDiff, "")}\n`
        : rawDiff;
    return [boundedToolFileChange({
      path: movePath ?? filePath,
      operation,
      previousPath: movePath ? filePath : null,
      diff,
    })];
  });
  return files.length > 0 ? withinCallBudget(files) : null;
}

