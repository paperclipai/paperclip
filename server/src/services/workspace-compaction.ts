import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Directory names that hold regenerable output: installed dependencies, build
// output, and tool caches. Compaction removes a directory only when its name is
// in this set, Git ignores it, and it holds no tracked file. Removing one leaves
// the worktree in the same state as a freshly created worktree, so whatever
// produced it the first time (the workspace provision command, or the agent)
// produces it again when the task resumes.
export const REGENERABLE_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "storybook-static",
  "target",
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".vite",
]);

// Compaction never descends into these directories. `.paperclip` holds the
// worktree's own Paperclip instance data, which is not regenerable.
const PROTECTED_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set([".git", ".paperclip"]);

// Moved directories wait here before deletion. The trash sits beside the
// worktree so the move is a same-filesystem rename, which is atomic and fast.
// A branch name cannot start with ".", so the name never collides with a
// worktree directory.
export const WORKSPACE_COMPACTION_TRASH_DIR = ".paperclip-compaction-trash";

const MAX_WALK_DEPTH = 12;

// Each Git read has a deadline and stops when the sweep is aborted, so a stalled
// Git process cannot hold the reaper.
const GIT_READ_TIMEOUT_MS = 60_000;

async function runGitRead(
  worktreePath: string,
  args: string[],
  options: { signal?: AbortSignal; input?: string; okExitCodes?: number[] } = {},
) {
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", worktreePath, ...args],
      { cwd: worktreePath, timeout: GIT_READ_TIMEOUT_MS, signal: options.signal, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode = (error as { code?: unknown } | null)?.code;
        if (!error || (typeof exitCode === "number" && options.okExitCodes?.includes(exitCode))) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
    // Git can exit before it reads stdin (or never reads it). A write to the
    // closed pipe then fails with EPIPE; the exit status above already reports
    // any real failure, so the stream error is not a second outcome.
    child.stdin?.on("error", () => {});
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

function splitNul(output: string) {
  return output.split("\0");
}

function isRepositoryGitignore(source: string) {
  return !path.isAbsolute(source)
    && !source.split("/").includes("..")
    && path.posix.basename(source) === ".gitignore";
}

// Keeps the candidates that Git ignores and that hold no tracked file.
// `check-ignore` answers per path, also for a path below an ignored parent.
// It exits 1 when no path is ignored, which is a normal answer.
async function filterRemovableCandidates(worktreePath: string, candidates: string[], signal?: AbortSignal) {
  // With --verbose --non-matching -z, each path yields four fields: source,
  // line number, pattern, and path. The source is empty for a path that no
  // pattern matches. Verbose output also reports a negating pattern such as
  // `!build/`, which means Git does NOT ignore the path, so only a match by a
  // non-negated pattern counts. Only the repository's own `.gitignore` files
  // count as evidence: a user's global excludes file or `.git/info/exclude`
  // says nothing about whether this repository's directory is regenerable.
  const fields = splitNul(await runGitRead(
    worktreePath,
    ["check-ignore", "--stdin", "-z", "--verbose", "--non-matching"],
    { signal, input: candidates.map((candidate) => `${candidate}\0`).join(""), okExitCodes: [1] },
  ));
  const ignored = new Set<string>();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, , pattern, candidate] = fields.slice(index, index + 4);
    if (source && pattern && !pattern.startsWith("!") && isRepositoryGitignore(source)) ignored.add(candidate!);
  }
  const ignoredCandidates = candidates.filter((candidate) => ignored.has(candidate));
  if (ignoredCandidates.length === 0) return [];
  // A directory that holds a tracked file is source, even when Git ignores it.
  // Literal pathspecs: a candidate is a path, never a pattern.
  const tracked = splitNul(await runGitRead(
    worktreePath,
    ["--literal-pathspecs", "ls-files", "-z", "--", ...ignoredCandidates],
    { signal },
  ))
    .filter((entry) => entry.length > 0);
  return ignoredCandidates.filter((candidate) =>
    !tracked.some((trackedPath) => trackedPath === candidate || trackedPath.startsWith(`${candidate}/`)));
}

// Returns true only for a linked Git worktree: its `.git` entry is a file that
// points at the main repository. A main checkout has a `.git` directory, and
// compaction never touches one.
export async function isLinkedGitWorktree(worktreePath: string) {
  const stat = await fs.lstat(path.join(worktreePath, ".git")).catch(() => null);
  return stat?.isFile() === true;
}

function hasGitEntry(entries: { name: string }[]) {
  return entries.some((entry) => entry.name === ".git");
}

// Returns true when a directory holds, at any depth, a `.git` or `.paperclip`
// entry: another repository (with its own source and unpublished history) or
// Paperclip instance data. The outer repository's index and ignore rules say
// nothing about either, so such a directory is never removed. Symlinks are not
// followed. A directory that cannot be read counts as protected.
async function containsProtectedEntry(directory: string, signal?: AbortSignal) {
  const pending = [directory];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (PROTECTED_WORKSPACE_DIR_NAMES.has(entry.name)) return true;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

// Lists the regenerable directories in a worktree, as paths relative to the
// worktree root. Symlinks are never followed or returned. A directory with a
// regenerable name that does not qualify (for example a tracked `build/`) is
// searched in turn, so eligible directories inside it are still found. The
// search stops at a nested checkout: this worktree's rules do not apply there.
export async function findRegenerableWorkspaceDirs(
  worktreePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const removable: string[] = [];

  async function collect(relativeDir: string, depth: number, candidates: string[]) {
    options.signal?.throwIfAborted();
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await fs.readdir(path.join(worktreePath, relativeDir), { withFileTypes: true })
      .catch(() => []);
    if (relativeDir && hasGitEntry(entries)) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (PROTECTED_WORKSPACE_DIR_NAMES.has(entry.name)) continue;
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (REGENERABLE_WORKSPACE_DIR_NAMES.has(entry.name)) {
        candidates.push(relativePath);
        continue;
      }
      await collect(relativePath, depth + 1, candidates);
    }
  }

  let roots = [""];
  while (roots.length > 0) {
    const candidates: string[] = [];
    for (const root of roots) {
      await collect(root, root ? root.split("/").length : 0, candidates);
    }
    if (candidates.length === 0) break;
    const ignored = new Set(await filterRemovableCandidates(worktreePath, candidates, options.signal));
    const protectedCandidates = new Set<string>();
    for (const candidate of ignored) {
      if (await containsProtectedEntry(path.join(worktreePath, candidate), options.signal)) protectedCandidates.add(candidate);
    }
    removable.push(...candidates.filter((candidate) => ignored.has(candidate) && !protectedCandidates.has(candidate)));
    // A protected candidate is kept whole and not searched further.
    roots = candidates.filter((candidate) => !ignored.has(candidate));
  }
  return removable;
}

// An isolated task directory is not a worktree itself. It holds the task's own
// files and, often, repository checkouts that the agent cloned into it. Each
// checkout, including one nested inside another, is compacted as its own root,
// so that checkout's `.gitignore` and index decide what is regenerable. Files
// outside every checkout are never candidates.
const MAX_TASK_DIRECTORY_CHECKOUT_DEPTH = 4;

async function findGitCheckouts(root: string, signal?: AbortSignal) {
  const checkouts: string[] = [];
  async function visit(relativeDir: string, depth: number) {
    signal?.throwIfAborted();
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      checkouts.push(relativeDir);
    }
    if (depth >= MAX_TASK_DIRECTORY_CHECKOUT_DEPTH) return;
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory()) continue;
      if (PROTECTED_WORKSPACE_DIR_NAMES.has(entry.name) || REGENERABLE_WORKSPACE_DIR_NAMES.has(entry.name)) continue;
      if (entry.name === WORKSPACE_COMPACTION_TRASH_DIR) continue;
      await visit(relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name, depth + 1);
    }
  }
  await visit("", 0);
  return checkouts;
}

// Lists the regenerable directories of every Git checkout inside an isolated
// task directory, as paths relative to the task directory.
export async function findTaskDirectoryRegenerableDirs(
  taskDirectory: string,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const removable: string[] = [];
  for (const checkout of await findGitCheckouts(taskDirectory, options.signal)) {
    const checkoutPath = checkout ? path.join(taskDirectory, checkout) : taskDirectory;
    for (const relativePath of await findRegenerableWorkspaceDirs(checkoutPath, options)) {
      removable.push(checkout ? path.posix.join(checkout, relativePath) : relativePath);
    }
  }
  return removable;
}

export type MovedWorkspaceDir = { relativePath: string; trashPath: string };

export type WorkspaceCompactionMove = {
  trashDir: string;
  moved: MovedWorkspaceDir[];
};

// Moves each directory into a fresh trash directory beside the worktree. Each
// move is one rename, so the whole step is fast enough to run while the caller
// holds the workspace lifecycle lock. A path that is no longer a real
// directory, or that sits on another filesystem, is left in place.
export async function moveWorkspaceDirsToTrash(
  worktreePath: string,
  relativePaths: string[],
): Promise<WorkspaceCompactionMove> {
  const trashDir = path.join(
    path.dirname(worktreePath),
    WORKSPACE_COMPACTION_TRASH_DIR,
    `${path.basename(worktreePath)}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  await fs.mkdir(trashDir, { recursive: true });
  const moved: MovedWorkspaceDir[] = [];
  for (const [index, relativePath] of relativePaths.entries()) {
    const sourcePath = path.join(worktreePath, relativePath);
    const stat = await fs.lstat(sourcePath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const trashPath = path.join(trashDir, String(index));
    try {
      await fs.rename(sourcePath, trashPath);
      moved.push({ relativePath, trashPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") continue;
      await restoreWorkspaceDirsFromTrash(worktreePath, { trashDir, moved });
      throw error;
    }
  }
  return { trashDir, moved };
}

// Puts moved directories back. A path that something recreated in the meantime
// keeps the new copy, and the moved copy stays in the trash for deletion.
export async function restoreWorkspaceDirsFromTrash(worktreePath: string, move: WorkspaceCompactionMove) {
  for (const entry of [...move.moved].reverse()) {
    const targetPath = path.join(worktreePath, entry.relativePath);
    const occupied = await fs.lstat(targetPath).then(() => true, () => false);
    if (occupied) continue;
    await fs.rename(entry.trashPath, targetPath);
  }
}

export async function deleteWorkspaceCompactionTrash(trashDir: string) {
  await fs.rm(trashDir, { recursive: true, force: true });
}

// Deletes trash directories that a crash or restart left behind. A trash entry
// younger than `olderThanMs` may belong to a compaction in progress, so it stays.
export async function purgeStaleWorkspaceCompactionTrash(worktreeParentDir: string, olderThanMs: number) {
  const trashRoot = path.join(worktreeParentDir, WORKSPACE_COMPACTION_TRASH_DIR);
  const entries = await fs.readdir(trashRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    const entryPath = path.join(trashRoot, entry.name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;
    await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
  }
}
