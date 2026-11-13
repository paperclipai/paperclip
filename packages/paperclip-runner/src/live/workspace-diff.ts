import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const PAPERCLIP_WORKSPACE_DIFF_SCHEMA = "paperclip.workspace.diff.v1" as const;

export type PaperclipWorkspaceChangeSource = "harness_reported" | "runner_verified";
export type PaperclipWorkspaceFileOperation =
  | "create"
  | "modify"
  | "delete"
  | "rename"
  | "mode_change";

export interface PaperclipWorkspaceFileChange {
  path: string;
  operation: PaperclipWorkspaceFileOperation;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  diff: string | null;
}

export interface PaperclipWorkspaceDiff {
  schema: typeof PAPERCLIP_WORKSPACE_DIFF_SCHEMA;
  changeSetId: string;
  revision: number;
  source: PaperclipWorkspaceChangeSource;
  complete: boolean;
  files: PaperclipWorkspaceFileChange[];
  totals: { files: number; additions: number | null; deletions: number | null };
  patchArtifactRef: string | null;
}

interface WorkspaceFileSnapshot {
  hash: string;
  content: Buffer | null;
  binary: boolean;
}

export type PaperclipWorkspaceSnapshot = Map<string, WorkspaceFileSnapshot>;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".paperclip-runner-prp",
  ".paperclip-runner",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const MAX_FILES = 2_000;
const MAX_DIRECTORIES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DIFF_CHARS_PER_FILE = 128 * 1024;

function normalizedRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function appearsBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8_192)).includes(0);
}

/**
 * Captures only the authorized workspace. Runner-owned state and common
 * dependency/VCS directories are excluded, symlinks are never followed, and
 * hard limits make this safe to run around an interactive turn.
 */
export async function capturePaperclipWorkspace(
  root: string,
  options: { signal?: AbortSignal } = {},
): Promise<PaperclipWorkspaceSnapshot> {
  const result: PaperclipWorkspaceSnapshot = new Map();
  let retainedBytes = 0;
  let visitedDirectories = 0;
  const throwIfAborted = () => options.signal?.throwIfAborted();

  async function visit(directory: string): Promise<void> {
    throwIfAborted();
    if (result.size >= MAX_FILES || retainedBytes >= MAX_TOTAL_BYTES || visitedDirectories >= MAX_DIRECTORIES) return;
    visitedDirectories += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throwIfAborted();
      return;
    }
    throwIfAborted();
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted();
      if (result.size >= MAX_FILES || retainedBytes >= MAX_TOTAL_BYTES) return;
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath, { signal: options.signal });
      } catch {
        throwIfAborted();
        continue;
      }
      const binary = appearsBinary(bytes);
      const retain = bytes.length <= MAX_FILE_BYTES && retainedBytes + bytes.length <= MAX_TOTAL_BYTES;
      const content = retain ? bytes : null;
      if (content !== null) retainedBytes += content.length;
      result.set(normalizedRelativePath(root, absolutePath), {
        hash: createHash("sha256").update(bytes).digest("hex"),
        content,
        binary: binary || content === null,
      });
    }
  }

  await visit(root);
  return result;
}

function lines(content: Buffer | null): string[] {
  if (content === null || content.length === 0) return [];
  const value = content.toString("utf8");
  const result = value.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function unifiedDiff(path: string, before: Buffer | null, after: Buffer | null): {
  diff: string;
  additions: number;
  deletions: number;
} {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = Math.min(prefix + 1, Math.max(1, oldLines.length));
  const newStart = Math.min(prefix + 1, Math.max(1, newLines.length));
  const header = [
    `diff --git a/${path} b/${path}`,
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
  ];
  const patch = [...header, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
  return {
    diff: patch.length <= MAX_DIFF_CHARS_PER_FILE
      ? `${patch}\n`
      : `${patch.slice(0, MAX_DIFF_CHARS_PER_FILE)}\n… diff truncated by runner …\n`,
    additions: added.length,
    deletions: removed.length,
  };
}

export function diffPaperclipWorkspace(
  before: PaperclipWorkspaceSnapshot,
  after: PaperclipWorkspaceSnapshot,
  changeSetId: string,
): PaperclipWorkspaceDiff | null {
  const files: PaperclipWorkspaceFileChange[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const prior = before.get(path);
    const current = after.get(path);
    if (prior?.hash === current?.hash) continue;
    const operation = prior === undefined ? "create" : current === undefined ? "delete" : "modify";
    const binary = prior?.binary === true || current?.binary === true;
    const stats = binary
      ? { diff: null, additions: null, deletions: null }
      : unifiedDiff(path, prior?.content ?? null, current?.content ?? null);
    files.push({ path, operation, previousPath: null, binary, ...stats });
  }
  if (files.length === 0) return null;

  // Exact-content delete/create pairs are represented as a rename. This keeps
  // the protocol semantic even when the harness only used shell commands.
  const deletedByHash = new Map<string, PaperclipWorkspaceFileChange>();
  for (const file of files) {
    if (file.operation === "delete") deletedByHash.set(before.get(file.path)!.hash, file);
  }
  for (const file of [...files]) {
    if (file.operation !== "create") continue;
    const deleted = deletedByHash.get(after.get(file.path)!.hash);
    if (deleted === undefined) continue;
    const deletedIndex = files.indexOf(deleted);
    if (deletedIndex >= 0) files.splice(deletedIndex, 1);
    file.operation = "rename";
    file.previousPath = deleted.path;
    file.additions = 0;
    file.deletions = 0;
    file.diff = `similarity index 100%\nrename from ${deleted.path}\nrename to ${file.path}\n`;
    deletedByHash.delete(after.get(file.path)!.hash);
  }

  const hasUnknownStats = files.some((file) => file.additions === null || file.deletions === null);
  return {
    schema: PAPERCLIP_WORKSPACE_DIFF_SCHEMA,
    changeSetId,
    revision: 1,
    source: "runner_verified",
    complete: true,
    files,
    totals: {
      files: files.length,
      additions: hasUnknownStats ? null : files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: hasUnknownStats ? null : files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    patchArtifactRef: null,
  };
}
