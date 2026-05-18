import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import type {
  WorkspaceDiffCaps,
  WorkspaceDiffFile,
  WorkspaceDiffFilePatch,
  WorkspaceDiffFileStatus,
  WorkspaceDiffPatchKind,
  WorkspaceDiffQueryOptions,
  WorkspaceDiffResponse,
  WorkspaceDiffWarning,
  WorkspaceDiffWarningCode,
} from "./contracts.js";

const execFileAsync = promisify(execFile);

export const WORKSPACE_DIFF_CAPS: WorkspaceDiffCaps = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxPatchBytes: 256 * 1024,
  maxTotalPatchBytes: 1024 * 1024,
};

const GIT_TIMEOUT_MS = 10_000;
const GIT_LIST_MAX_BUFFER = 2 * 1024 * 1024;
const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

interface GitStatusEntry {
  status: WorkspaceDiffFileStatus;
  path: string;
  oldPath: string | null;
}

type DiffScope = "staged" | "unstaged" | "head";

interface MutableWorkspaceDiffFile extends WorkspaceDiffFile {
  patchScopes: DiffScope[];
}

interface PatchBudget {
  totalPatchBytes: number;
}

type WorkspaceDiffTarget = Pick<PluginExecutionWorkspaceMetadata, "id" | "companyId" | "cwd" | "baseRef">;

function warning(code: WorkspaceDiffWarningCode, message: string, filePath: string | null = null): WorkspaceDiffWarning {
  return { code, message, path: filePath };
}

function workspaceDiffError(code: WorkspaceDiffWarningCode, message: string, details: Record<string, unknown> = {}) {
  const error = new Error(message);
  Object.assign(error, { code, status: 422, details: { code, ...details } });
  return error;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runGit(cwd: string, args: string[], maxBuffer = GIT_LIST_MAX_BUFFER) {
  try {
    return await execFileAsync("git", ["-C", cwd, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
    });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? String((error as { stderr?: unknown }).stderr).trim()
      : "";
    const message = stderr || toErrorMessage(error);
    throw workspaceDiffError("git_command_failed", message, { args });
  }
}

async function realDirectory(value: string, code: WorkspaceDiffWarningCode) {
  if (!path.isAbsolute(value)) {
    throw workspaceDiffError(code, "Execution workspace path must be absolute", { cwd: value });
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(value);
  } catch {
    throw workspaceDiffError(code, "Execution workspace path does not exist", { cwd: value });
  }
  if (!stat.isDirectory()) {
    throw workspaceDiffError(code, "Execution workspace path is not a directory", { cwd: value });
  }
  return await fs.realpath(value);
}

function isWithinDirectory(childPath: string, parentPath: string) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWorkspacePaths(workspace: WorkspaceDiffTarget) {
  if (!workspace.cwd?.trim()) {
    throw workspaceDiffError(
      "missing_cwd",
      "Execution workspace needs a local path before Paperclip can inspect diffs",
      { workspaceId: workspace.id },
    );
  }

  const cwd = await realDirectory(workspace.cwd.trim(), "workspace_path_invalid");
  let repoRoot: string;
  try {
    repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch {
    throw workspaceDiffError(
      "non_git_workspace",
      "Execution workspace path is not inside a git repository",
      { workspaceId: workspace.id, cwd },
    );
  }

  const repoRootReal = await realDirectory(repoRoot, "non_git_workspace");
  if (!isWithinDirectory(cwd, repoRootReal)) {
    throw workspaceDiffError(
      "workspace_path_invalid",
      "Execution workspace path resolved outside its git repository",
      { workspaceId: workspace.id, cwd, repoRoot: repoRootReal },
    );
  }

  return { cwd, repoRoot: repoRootReal };
}

function normalizePathFilter(rawPath: string) {
  const value = rawPath.trim().replaceAll("\\", "/");
  if (!value || value === ".") return null;
  if (value.includes("\0") || value.startsWith("/")) {
    throw workspaceDiffError("path_filter_invalid", "Path filters must be relative workspace paths", { path: rawPath });
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw workspaceDiffError(
      "path_filter_invalid",
      "Path filters must not contain traversal segments",
      { path: rawPath },
    );
  }
  return normalized;
}

function normalizePathFilters(paths: string[]) {
  return Array.from(new Set(paths.map(normalizePathFilter).filter((value): value is string => Boolean(value))));
}

function statusFromGitStatus(status: string): WorkspaceDiffFileStatus {
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "T":
      return "type_changed";
    default:
      return "unknown";
  }
}

function parseNameStatus(output: string): GitStatusEntry[] {
  const tokens = output.split("\0").filter(Boolean);
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusCode = tokens[index++] ?? "";
    if (!statusCode) continue;
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const oldPath = tokens[index++] ?? "";
      const newPath = tokens[index++] ?? "";
      if (newPath) {
        entries.push({
          status: statusFromGitStatus(statusCode),
          path: newPath,
          oldPath: oldPath || null,
        });
      }
      continue;
    }

    const filePath = tokens[index++] ?? "";
    if (filePath) {
      entries.push({
        status: statusFromGitStatus(statusCode),
        path: filePath,
        oldPath: null,
      });
    }
  }
  return entries;
}

async function readDiffNameStatus(cwd: string, scopeArgs: string[], paths: string[]) {
  const result = await runGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--find-renames",
    ...scopeArgs,
    "--",
    ...paths,
  ]);
  return parseNameStatus(result.stdout);
}

async function readUntrackedPaths(cwd: string, paths: string[]) {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]);
  return result.stdout.split("\0").filter(Boolean);
}

function ensureFile(
  files: Map<string, MutableWorkspaceDiffFile>,
  filePath: string,
  status: WorkspaceDiffFileStatus,
  oldPath: string | null,
) {
  const existing = files.get(filePath);
  if (existing) {
    if (existing.status === "unknown" || status === "renamed" || status === "copied") {
      existing.status = status;
    }
    if (!existing.oldPath && oldPath) existing.oldPath = oldPath;
    return existing;
  }

  const file: MutableWorkspaceDiffFile = {
    path: filePath,
    oldPath,
    status,
    staged: false,
    unstaged: false,
    untracked: false,
    binary: false,
    oversized: false,
    truncated: false,
    additions: 0,
    deletions: 0,
    sizeBytes: null,
    patches: [],
    warnings: [],
    patchScopes: [],
  };
  files.set(filePath, file);
  return file;
}

function addStatusEntries(
  files: Map<string, MutableWorkspaceDiffFile>,
  entries: GitStatusEntry[],
  scope: DiffScope,
) {
  for (const entry of entries) {
    const file = ensureFile(files, entry.path, entry.status, entry.oldPath);
    if (scope === "staged") file.staged = true;
    else if (scope === "unstaged") file.unstaged = true;
    if (!file.patchScopes.includes(scope)) file.patchScopes.push(scope);
  }
}

function parseNumstat(output: string) {
  const line = output.split(/\r?\n/).find(Boolean);
  if (!line) return { additions: 0, deletions: 0, binary: false };
  const [additionsRaw, deletionsRaw] = line.split(/\t/);
  if (additionsRaw === "-" || deletionsRaw === "-") {
    return { additions: 0, deletions: 0, binary: true };
  }
  return {
    additions: Number.parseInt(additionsRaw ?? "0", 10) || 0,
    deletions: Number.parseInt(deletionsRaw ?? "0", 10) || 0,
    binary: false,
  };
}

async function readNumstat(cwd: string, scopeArgs: string[], filePath: string) {
  const result = await runGit(cwd, [
    "diff",
    "--numstat",
    "--no-ext-diff",
    "--find-renames",
    ...scopeArgs,
    "--",
    filePath,
  ], 128 * 1024);
  return parseNumstat(result.stdout);
}

async function statWorkspaceFile(repoRoot: string, filePath: string) {
  const resolved = await resolveWorkspaceFilePath(repoRoot, filePath);
  if (resolved.status !== "ok") return null;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(resolved.realPath, fsConstants.O_RDONLY | OPEN_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function resolveWorkspaceFilePath(repoRoot: string, filePath: string): Promise<
  | { status: "ok"; realPath: string }
  | { status: "missing" }
  | { status: "outside_workspace" }
> {
  const target = path.resolve(repoRoot, filePath);
  if (!isWithinDirectory(target, repoRoot)) return { status: "outside_workspace" };
  try {
    const realPath = await fs.realpath(target);
    if (!isWithinDirectory(realPath, repoRoot)) return { status: "outside_workspace" };
    return { status: "ok", realPath };
  } catch {
    return { status: "missing" };
  }
}

function isMaxBufferError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

async function readPatchOutput(cwd: string, args: string[]) {
  try {
    return await execFileAsync("git", ["-C", cwd, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: WORKSPACE_DIFF_CAPS.maxPatchBytes + 64 * 1024,
    });
  } catch (error) {
    if (isMaxBufferError(error)) {
      return null;
    }
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? String((error as { stderr?: unknown }).stderr).trim()
      : "";
    throw workspaceDiffError("git_command_failed", stderr || toErrorMessage(error), { args });
  }
}

function reservePatchBytes(
  patch: string,
  budget: PatchBudget,
  filePath: string,
  warnings: WorkspaceDiffWarning[],
) {
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > WORKSPACE_DIFF_CAPS.maxPatchBytes) {
    warnings.push(warning("patch_truncated", "File patch exceeded the per-file diff cap.", filePath));
    return null;
  }
  if (budget.totalPatchBytes + patchBytes > WORKSPACE_DIFF_CAPS.maxTotalPatchBytes) {
    warnings.push(warning("patch_truncated", "Workspace diff exceeded the total patch cap.", filePath));
    return null;
  }
  budget.totalPatchBytes += patchBytes;
  return patch;
}

async function buildTrackedPatch(input: {
  cwd: string;
  repoRoot: string;
  filePath: string;
  kind: WorkspaceDiffPatchKind;
  scopeArgs: string[];
  budget: PatchBudget;
}): Promise<WorkspaceDiffFilePatch> {
  const warnings: WorkspaceDiffWarning[] = [];
  const numstat = await readNumstat(input.cwd, input.scopeArgs, input.filePath);
  const sizeBytes = await statWorkspaceFile(input.repoRoot, input.filePath);

  if (numstat.binary) {
    warnings.push(warning("binary_file", "Binary files are summarized without a text patch.", input.filePath));
    return {
      kind: input.kind,
      patch: null,
      additions: 0,
      deletions: 0,
      binary: true,
      oversized: false,
      truncated: false,
      warnings,
    };
  }

  if (sizeBytes !== null && sizeBytes > WORKSPACE_DIFF_CAPS.maxFileBytes) {
    warnings.push(warning("file_oversized", "File is too large to include a text patch.", input.filePath));
    return {
      kind: input.kind,
      patch: null,
      additions: numstat.additions,
      deletions: numstat.deletions,
      binary: false,
      oversized: true,
      truncated: false,
      warnings,
    };
  }

  const patchOutput = await readPatchOutput(input.cwd, [
    "diff",
    "--no-ext-diff",
    "--find-renames",
    "--unified=3",
    ...input.scopeArgs,
    "--",
    input.filePath,
  ]);
  if (!patchOutput) {
    warnings.push(warning("patch_truncated", "File patch exceeded the per-file diff cap.", input.filePath));
    return {
      kind: input.kind,
      patch: null,
      additions: numstat.additions,
      deletions: numstat.deletions,
      binary: false,
      oversized: false,
      truncated: true,
      warnings,
    };
  }

  const patch = reservePatchBytes(patchOutput.stdout, input.budget, input.filePath, warnings);
  return {
    kind: input.kind,
    patch,
    additions: numstat.additions,
    deletions: numstat.deletions,
    binary: false,
    oversized: false,
    truncated: patch === null,
    warnings,
  };
}

function isProbablyBinary(buffer: Buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}

function countAddedLines(content: string) {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function buildUntrackedPatch(filePath: string, content: string) {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const lineCount = countAddedLines(content);
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
  ];
  if (lineCount === 0) return `${header.join("\n")}\n`;
  const hunkLines = lines.map((line) => `+${line}`).join("\n");
  return [...header, `@@ -0,0 +1,${lineCount} @@`, hunkLines, ""].join("\n");
}

async function buildUntrackedFilePatch(input: {
  repoRoot: string;
  filePath: string;
  budget: PatchBudget;
}): Promise<WorkspaceDiffFilePatch> {
  const warnings: WorkspaceDiffWarning[] = [];
  const resolved = await resolveWorkspaceFilePath(input.repoRoot, input.filePath);
  if (resolved.status === "outside_workspace") {
    warnings.push(warning(
      "symlink_target_outside_workspace",
      "Untracked file resolves outside the workspace and is summarized without reading target bytes.",
      input.filePath,
    ));
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: false,
      oversized: false,
      truncated: false,
      warnings,
    };
  }
  if (resolved.status === "missing") {
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: false,
      oversized: false,
      truncated: false,
      warnings,
    };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(resolved.realPath, fsConstants.O_RDONLY | OPEN_NOFOLLOW);
  } catch {
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: false,
      oversized: false,
      truncated: false,
      warnings,
    };
  }

  let sizeBytes: number;
  let buffer: Buffer | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        kind: "untracked",
        patch: null,
        additions: 0,
        deletions: 0,
        binary: false,
        oversized: false,
        truncated: false,
        warnings,
      };
    }
    sizeBytes = stat.size;
    if (sizeBytes <= WORKSPACE_DIFF_CAPS.maxFileBytes) {
      buffer = await handle.readFile();
    }
  } finally {
    await handle.close();
  }

  if (sizeBytes > WORKSPACE_DIFF_CAPS.maxFileBytes) {
    warnings.push(warning("file_oversized", "Untracked file is too large to include a text patch.", input.filePath));
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: false,
      oversized: true,
      truncated: false,
      warnings,
    };
  }

  if (!buffer) {
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: false,
      oversized: false,
      truncated: false,
      warnings,
    };
  }
  if (isProbablyBinary(buffer)) {
    warnings.push(warning("binary_file", "Binary files are summarized without a text patch.", input.filePath));
    return {
      kind: "untracked",
      patch: null,
      additions: 0,
      deletions: 0,
      binary: true,
      oversized: false,
      truncated: false,
      warnings,
    };
  }

  const content = buffer.toString("utf8");
  const patch = reservePatchBytes(buildUntrackedPatch(input.filePath, content), input.budget, input.filePath, warnings);
  return {
    kind: "untracked",
    patch,
    additions: countAddedLines(content),
    deletions: 0,
    binary: false,
    oversized: false,
    truncated: patch === null,
    warnings,
  };
}

function applyPatchToFile(file: MutableWorkspaceDiffFile, patch: WorkspaceDiffFilePatch, sizeBytes: number | null) {
  file.patches.push(patch);
  file.additions += patch.additions;
  file.deletions += patch.deletions;
  file.binary = file.binary || patch.binary;
  file.oversized = file.oversized || patch.oversized;
  file.truncated = file.truncated || patch.truncated;
  file.warnings.push(...patch.warnings);
  if (file.sizeBytes === null && sizeBytes !== null) file.sizeBytes = sizeBytes;
}

function finalizeStats(files: WorkspaceDiffFile[]) {
  return {
    fileCount: files.length,
    stagedFileCount: files.filter((file) => file.staged).length,
    unstagedFileCount: files.filter((file) => file.unstaged).length,
    untrackedFileCount: files.filter((file) => file.untracked).length,
    binaryFileCount: files.filter((file) => file.binary).length,
    oversizedFileCount: files.filter((file) => file.oversized).length,
    truncatedFileCount: files.filter((file) => file.truncated).length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

async function resolveHeadSha(cwd: string) {
  try {
    return (await runGit(cwd, ["rev-parse", "HEAD"], 128 * 1024)).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function resolveBaseRef(cwd: string, baseRef: string | null, workspace: WorkspaceDiffTarget) {
  const resolvedBaseRef = baseRef ?? workspace.baseRef ?? null;
  if (!resolvedBaseRef) {
    throw workspaceDiffError(
      "base_ref_missing",
      "A baseRef query parameter or execution workspace baseRef is required for head diffs",
      { workspaceId: workspace.id },
    );
  }
  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${resolvedBaseRef}^{commit}`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    });
  } catch {
    throw workspaceDiffError(
      "base_ref_invalid",
      `Could not resolve baseRef "${resolvedBaseRef}" in this workspace`,
      { workspaceId: workspace.id, baseRef: resolvedBaseRef },
    );
  }
  return resolvedBaseRef;
}

async function collectFiles(input: {
  cwd: string;
  workspace: WorkspaceDiffTarget;
  query: WorkspaceDiffQueryOptions;
  paths: string[];
}) {
  const files = new Map<string, MutableWorkspaceDiffFile>();
  let baseRef: string | null = null;

  if (input.query.view === "head") {
    baseRef = await resolveBaseRef(input.cwd, input.query.baseRef, input.workspace);
    addStatusEntries(
      files,
      await readDiffNameStatus(input.cwd, [`${baseRef}...HEAD`], input.paths),
      "head",
    );
  } else {
    addStatusEntries(files, await readDiffNameStatus(input.cwd, ["--cached"], input.paths), "staged");
    addStatusEntries(files, await readDiffNameStatus(input.cwd, [], input.paths), "unstaged");
    if (input.query.includeUntracked) {
      for (const untrackedPath of await readUntrackedPaths(input.cwd, input.paths)) {
        const file = ensureFile(files, untrackedPath, "untracked", null);
        file.untracked = true;
        if (!file.patchScopes.includes("unstaged")) file.patchScopes.push("unstaged");
      }
    }
  }

  return { files, baseRef };
}

export function workspaceDiffService() {
  return {
    async getDiff(workspace: WorkspaceDiffTarget, query: WorkspaceDiffQueryOptions): Promise<WorkspaceDiffResponse> {
      const { cwd, repoRoot } = await resolveWorkspacePaths(workspace);
      const paths = normalizePathFilters(query.paths);
      const warnings: WorkspaceDiffWarning[] = [];
      const { files: filesByPath, baseRef } = await collectFiles({ cwd, workspace, query, paths });
      const allFiles = Array.from(filesByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
      const cappedFiles = allFiles.slice(0, WORKSPACE_DIFF_CAPS.maxFiles);
      if (allFiles.length > cappedFiles.length) {
        warnings.push(warning(
          "file_count_truncated",
          `Workspace diff includes ${allFiles.length} files, so only the first ${WORKSPACE_DIFF_CAPS.maxFiles} are returned.`,
        ));
      }

      const patchBudget: PatchBudget = { totalPatchBytes: 0 };
      for (const file of cappedFiles) {
        if (query.view === "head") {
          const patch = await buildTrackedPatch({
            cwd,
            repoRoot,
            filePath: file.path,
            kind: "head",
            scopeArgs: [`${baseRef}...HEAD`],
            budget: patchBudget,
          });
          applyPatchToFile(file, patch, await statWorkspaceFile(repoRoot, file.path));
          continue;
        }

        if (file.staged) {
          const patch = await buildTrackedPatch({
            cwd,
            repoRoot,
            filePath: file.path,
            kind: "staged",
            scopeArgs: ["--cached"],
            budget: patchBudget,
          });
          applyPatchToFile(file, patch, await statWorkspaceFile(repoRoot, file.path));
        }
        if (file.unstaged) {
          const patch = await buildTrackedPatch({
            cwd,
            repoRoot,
            filePath: file.path,
            kind: "unstaged",
            scopeArgs: [],
            budget: patchBudget,
          });
          applyPatchToFile(file, patch, await statWorkspaceFile(repoRoot, file.path));
        }
        if (file.untracked) {
          const patch = await buildUntrackedFilePatch({
            repoRoot,
            filePath: file.path,
            budget: patchBudget,
          });
          applyPatchToFile(file, patch, await statWorkspaceFile(repoRoot, file.path));
        }
      }

      const files = cappedFiles.map(({ patchScopes: _patchScopes, ...file }) => file);
      const patchWarnings = files.flatMap((file) => file.warnings);
      return {
        workspaceId: workspace.id,
        companyId: workspace.companyId,
        view: query.view,
        baseRef,
        defaultBaseRef: workspace.baseRef,
        headSha: await resolveHeadSha(cwd),
        includeUntracked: query.includeUntracked,
        paths,
        files,
        stats: finalizeStats(files),
        warnings: [...warnings, ...patchWarnings],
        caps: WORKSPACE_DIFF_CAPS,
        truncated: warnings.some((item) => item.code === "file_count_truncated")
          || files.some((file) => file.truncated),
      };
    },
  };
}
