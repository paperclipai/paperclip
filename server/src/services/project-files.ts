import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  GitCommitResult,
  GitDiffResponse,
  GitPushResult,
  GitStatusEntry,
  GitStatusResponse,
  ProjectFileDetail,
  ProjectFilesAheadBehind,
  ProjectFilesBranch,
  ProjectFilesBranchSyncDetail,
  ProjectFilesBranchSyncResult,
  ProjectFilesDirtyState,
  ProjectFilesSummary,
  ProjectFilesSyncResult,
  ProjectFilesTreeEntry,
  ProjectFilesTreeResponse,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { projectService } from "./projects.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HIDDEN_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "vendor", ".git"]);
type ServiceProject = NonNullable<Awaited<ReturnType<ReturnType<typeof projectService>["getById"]>>>;

function normalizeRelativePath(input: string): string {
  const normalized = path.posix.normalize((input || "").replaceAll("\\", "/")).replace(/^\/+/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("File path must stay within the project root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalized);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("File path must stay within the project root");
  }
  return absolutePath;
}

function inferMimeType(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ts")) return "text/typescript";
  if (lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".js")) return "text/javascript";
  if (lower.endsWith(".jsx")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

function inferLanguage(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  return "text";
}

function isImagePath(filePath: string): boolean {
  const mime = inferMimeType(filePath);
  return typeof mime === "string" && mime.startsWith("image/");
}

function classifyTreeFileType(filePath: string): ProjectFilesTreeEntry["fileType"] {
  if (isImagePath(filePath)) return "image";
  const lower = filePath.toLowerCase();
  if (/\.(md|txt|json|ts|tsx|js|jsx|css|html|yml|yaml|sh|py|mjs|cjs|toml|xml|env|gitignore|npmrc)$/i.test(lower)) {
    return "text";
  }
  return "binary";
}

async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

function sanitizeGitError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    if (stderr) return stderr;
    if (stdout) return stdout;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function existsDir(targetPath: string | null): Promise<boolean> {
  if (!targetPath) return false;
  const stat = await fs.stat(targetPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function hasRemoteOrigin(repoRoot: string): Promise<boolean> {
  try {
    await runGit(["remote", "get-url", "origin"], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function initLocalGit(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
  await runGit(["init"], dirPath);
  await runGit(
    ["-c", "user.email=paperclip@local", "-c", "user.name=Paperclip", "commit", "--allow-empty", "-m", "Initial commit"],
    dirPath,
  );
}

async function cloneRepo(repoUrl: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runGit(["clone", repoUrl, targetPath], path.dirname(targetPath));
}

export async function initWorkspaceGit(project: ServiceProject): Promise<void> {
  const rootPath = project.codebase.effectiveLocalFolder;
  if (!rootPath) return;

  const dirExists = await existsDir(rootPath);
  if (dirExists) {
    try {
      await runGit(["rev-parse", "--git-dir"], rootPath);
      return; // already a git repo
    } catch {
      // directory exists but not initialized
    }
  }

  if (project.codebase.repoUrl) {
    await cloneRepo(project.codebase.repoUrl, rootPath);
  } else {
    await initLocalGit(rootPath);
  }
}

async function resolveProjectRoot(project: ServiceProject): Promise<string | null> {
  const candidatePaths = [
    project.primaryWorkspace?.cwd ?? null,
    project.codebase.effectiveLocalFolder ?? null,
    project.codebase.localFolder ?? null,
  ];
  for (const candidate of candidatePaths) {
    if (await existsDir(candidate)) return candidate;
  }
  return null;
}

async function inspectDirtyState(repoRoot: string): Promise<ProjectFilesDirtyState> {
  const output = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], repoRoot)).stdout;
  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("??")) {
      untrackedEntryCount += 1;
    } else {
      dirtyEntryCount += 1;
    }
  }
  return {
    hasDirtyTrackedFiles: dirtyEntryCount > 0,
    hasUntrackedFiles: untrackedEntryCount > 0,
    dirtyEntryCount,
    untrackedEntryCount,
  };
}

async function inspectAheadBehind(repoRoot: string): Promise<ProjectFilesAheadBehind | null> {
  try {
    const upstream = (await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot)).stdout.trim();
    if (!upstream) return null;
    const counts = (await runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], repoRoot)).stdout.trim();
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    return {
      ahead: aheadRaw ? Number.parseInt(aheadRaw, 10) : 0,
      behind: behindRaw ? Number.parseInt(behindRaw, 10) : 0,
    };
  } catch {
    return null;
  }
}

async function inspectBranches(repoRoot: string): Promise<{ currentBranch: string | null; branches: ProjectFilesBranch[] }> {
  const branches: ProjectFilesBranch[] = [];
  let currentBranch: string | null = null;
  try {
    const current = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
    currentBranch = current && current !== "HEAD" ? current : null;
  } catch {
    currentBranch = null;
  }

  try {
    const localRaw = (await runGit(["for-each-ref", "--format=%(refname:short)|%(upstream:short)", "refs/heads"], repoRoot)).stdout;
    for (const line of localRaw.split(/\r?\n/)) {
      if (!line) continue;
      const [name, tracking] = line.split("|");
      // "origin" as a local branch name collides with the remote name — exclude it
      if (!name || name === "origin") continue;
      branches.push({
        name,
        kind: "local",
        current: currentBranch === name,
        tracking: tracking || null,
      });
    }
  } catch {}

  try {
    const remoteRaw = (await runGit(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], repoRoot)).stdout;
    for (const line of remoteRaw.split(/\r?\n/)) {
      const name = line.trim();
      if (!name || name === "origin/HEAD" || name === "origin") continue;
      branches.push({
        name,
        kind: "remote",
        current: false,
        tracking: null,
      });
    }
  } catch {}

  branches.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  return { currentBranch, branches };
}

async function buildSummary(project: ServiceProject): Promise<ProjectFilesSummary> {
  const rootPath = await resolveProjectRoot(project);
  if (!rootPath) {
    return {
      available: false,
      companyId: project.companyId,
      projectId: project.id,
      workspaceId: project.primaryWorkspace?.id ?? null,
      workspaceName: project.primaryWorkspace?.name ?? null,
      rootPath: null,
      repoRoot: null,
      gitEnabled: false,
      hasRemote: false,
      currentBranch: null,
      branches: [],
      dirtyWorktree: null,
      aheadBehind: null,
    };
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], rootPath)).stdout.trim() || null;
  } catch {
    repoRoot = null;
  }

  const gitEnabled = Boolean(repoRoot);
  const hasRemote = repoRoot ? await hasRemoteOrigin(repoRoot) : false;
  const dirtyWorktree = repoRoot ? await inspectDirtyState(repoRoot) : null;
  const aheadBehind = repoRoot ? await inspectAheadBehind(repoRoot) : null;
  const branchInfo = repoRoot ? await inspectBranches(repoRoot) : { currentBranch: null, branches: [] };

  return {
    available: true,
    companyId: project.companyId,
    projectId: project.id,
    workspaceId: project.primaryWorkspace?.id ?? null,
    workspaceName: project.primaryWorkspace?.name ?? null,
    rootPath,
    repoRoot,
    gitEnabled,
    hasRemote,
    currentBranch: branchInfo.currentBranch,
    branches: branchInfo.branches,
    dirtyWorktree,
    aheadBehind,
  };
}

async function ensureProject(projectId: string, db: Db): Promise<ServiceProject> {
  const project = await projectService(db).getById(projectId);
  if (!project) throw notFound("Project not found");
  return project;
}

export function projectFilesService(db: Db) {
  async function saveFile(projectId: string, relativePath: string, content: string): Promise<ProjectFileDetail> {
    const project = await ensureProject(projectId, db);
    const summary = await buildSummary(project);
    if (!summary.available || !summary.rootPath) {
      throw badRequest("Project does not have a local workspace to browse");
    }
    const normalizedPath = normalizeRelativePath(relativePath);
    if (!normalizedPath) throw badRequest("File path is required");
    const absolutePath = resolvePathWithinRoot(summary.rootPath, normalizedPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return await readFile(projectId, normalizedPath);
  }

  async function readFile(projectId: string, relativePath: string): Promise<ProjectFileDetail> {
    const project = await ensureProject(projectId, db);
    const summary = await buildSummary(project);
    if (!summary.available || !summary.rootPath) {
      throw badRequest("Project does not have a local workspace to browse");
    }
    const normalizedPath = normalizeRelativePath(relativePath);
    if (!normalizedPath) throw badRequest("File path is required");
    const absolutePath = resolvePathWithinRoot(summary.rootPath, normalizedPath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      throw notFound("File not found");
    }

    if (isImagePath(normalizedPath)) {
      const raw = await fs.readFile(absolutePath);
      return {
        path: normalizedPath,
        name: path.basename(normalizedPath),
        fileType: "image",
        previewType: "image",
        size: stat.size,
        language: null,
        textContent: null,
        base64Content: raw.toString("base64"),
        mimeType: inferMimeType(normalizedPath),
        updatedAt: stat.mtime,
      };
    }

    const raw = await fs.readFile(absolutePath);
    const text = raw.toString("utf8");
    if (text.includes("\u0000")) {
      return {
        path: normalizedPath,
        name: path.basename(normalizedPath),
        fileType: "binary",
        previewType: "binary",
        size: stat.size,
        language: null,
        textContent: null,
        base64Content: null,
        mimeType: inferMimeType(normalizedPath),
        updatedAt: stat.mtime,
      };
    }

    let previewType: ProjectFileDetail["previewType"] = "text";
    let textContent = text;
    if (normalizedPath.toLowerCase().endsWith(".md")) {
      previewType = "markdown";
    } else if (normalizedPath.toLowerCase().endsWith(".json")) {
      previewType = "json";
      try {
        textContent = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
      } catch {}
    }

    return {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      fileType: "text",
      previewType,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      textContent,
      base64Content: null,
      mimeType: inferMimeType(normalizedPath),
      updatedAt: stat.mtime,
    };
  }

  return {
    async getSummary(projectId: string): Promise<ProjectFilesSummary> {
      return await buildSummary(await ensureProject(projectId, db));
    },

    async listTree(projectId: string, relativePath: string, showIgnored: boolean): Promise<ProjectFilesTreeResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.rootPath) {
        throw badRequest("Project does not have a local workspace to browse");
      }
      const normalizedPath = normalizeRelativePath(relativePath);
      const absolutePath = resolvePathWithinRoot(summary.rootPath, normalizedPath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isDirectory()) {
        throw notFound("Directory not found");
      }

      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const responseEntries: ProjectFilesTreeEntry[] = [];
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const hiddenByDefault = DEFAULT_HIDDEN_DIRS.has(entry.name);
        if (!showIgnored && hiddenByDefault) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const entryPath = normalizedPath ? `${normalizedPath}/${entry.name}` : entry.name;
        responseEntries.push({
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? "dir" : "file",
          hiddenByDefault,
          fileType: entry.isDirectory() ? "directory" : classifyTreeFileType(entry.name),
        });
      }

      responseEntries.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });

      return { path: normalizedPath, entries: responseEntries };
    },

    readFile,

    saveFile,

    async createFile(projectId: string, relativePath: string): Promise<ProjectFileDetail> {
      return await saveFile(projectId, relativePath, "");
    },

    async createFolder(projectId: string, relativePath: string): Promise<{ path: string }> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.rootPath) {
        throw badRequest("Project does not have a local workspace to browse");
      }
      const normalizedPath = normalizeRelativePath(relativePath);
      if (!normalizedPath) throw badRequest("Folder path is required");
      const absolutePath = resolvePathWithinRoot(summary.rootPath, normalizedPath);
      await fs.mkdir(absolutePath, { recursive: true });
      return { path: normalizedPath };
    },

    async renamePath(projectId: string, relativePath: string, nextRelativePath: string): Promise<{ path: string }> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.rootPath) {
        throw badRequest("Project does not have a local workspace to browse");
      }
      const currentPath = resolvePathWithinRoot(summary.rootPath, relativePath);
      const nextPath = resolvePathWithinRoot(summary.rootPath, nextRelativePath);
      await fs.mkdir(path.dirname(nextPath), { recursive: true });
      await fs.rename(currentPath, nextPath);
      return { path: normalizeRelativePath(nextRelativePath) };
    },

    async deletePath(projectId: string, relativePath: string): Promise<{ path: string }> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.rootPath) {
        throw badRequest("Project does not have a local workspace to browse");
      }
      const normalizedPath = normalizeRelativePath(relativePath);
      if (!normalizedPath) throw badRequest("Path is required");
      const absolutePath = resolvePathWithinRoot(summary.rootPath, normalizedPath);
      await fs.rm(absolutePath, { recursive: true, force: true });
      return { path: normalizedPath };
    },

    async switchBranch(projectId: string, branch: string, mode: "default" | "autostash" | "discard"): Promise<ProjectFilesSummary> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        throw badRequest("Project is not a git checkout");
      }
      const trimmedBranch = branch.trim();
      if (!trimmedBranch) throw badRequest("Branch is required");
      if (summary.currentBranch === trimmedBranch) return summary;

      if (summary.dirtyWorktree && (summary.dirtyWorktree.hasDirtyTrackedFiles || summary.dirtyWorktree.hasUntrackedFiles) && mode === "default") {
        throw conflict("Working tree has local changes", { dirtyWorktree: summary.dirtyWorktree });
      }

      let stashed = false;
      try {
        if (mode === "discard") {
          await runGit(["reset", "--hard", "HEAD"], summary.repoRoot);
          await runGit(["clean", "-fd"], summary.repoRoot);
        }

        if (mode === "autostash" && summary.dirtyWorktree && (summary.dirtyWorktree.hasDirtyTrackedFiles || summary.dirtyWorktree.hasUntrackedFiles)) {
          await runGit(["stash", "push", "--include-untracked", "-m", "paperclip-files-autostash"], summary.repoRoot);
          stashed = true;
        }

        if (trimmedBranch.startsWith("origin/")) {
          const localName = trimmedBranch.slice("origin/".length);
          await runGit(["switch", "-c", localName, "--track", trimmedBranch], summary.repoRoot);
        } else {
          await runGit(["switch", trimmedBranch], summary.repoRoot);
        }

        if (stashed) {
          await runGit(["stash", "pop"], summary.repoRoot);
        }
      } catch (error) {
        throw conflict(sanitizeGitError(error, `Failed to switch to ${trimmedBranch}`));
      }

      return await buildSummary(project);
    },

    async createBranch(projectId: string, name: string, startPoint?: string | null): Promise<ProjectFilesSummary> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        throw badRequest("Project is not a git checkout");
      }
      const trimmedName = name.trim();
      if (!trimmedName) throw badRequest("Branch name is required");
      const args = ["switch", "-c", trimmedName];
      if (startPoint && startPoint.trim()) args.push(startPoint.trim());
      try {
        await runGit(args, summary.repoRoot);
      } catch (error) {
        throw conflict(sanitizeGitError(error, `Failed to create branch ${trimmedName}`));
      }
      return await buildSummary(project);
    },

    async sync(projectId: string): Promise<ProjectFilesSyncResult> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        throw badRequest("Project is not a git checkout");
      }

      let status: ProjectFilesSyncResult["status"] = "success";
      let message: string | null = null;
      try {
        await runGit(["fetch", "origin"], summary.repoRoot);
        await runGit(["pull", "--rebase", "--autostash"], summary.repoRoot);
        await runGit(["push"], summary.repoRoot);
      } catch (error) {
        const errorMessage = sanitizeGitError(error, "Git sync failed");
        message = errorMessage;
        if (/auth|permission denied|could not read from remote repository|authentication/i.test(errorMessage)) {
          status = "auth_error";
        } else if (/conflict|resolve all conflicts|rebase/i.test(errorMessage)) {
          status = "conflict";
        } else {
          status = "error";
        }
      }

      return {
        status,
        summary: await buildSummary(project),
        message,
      };
    },

    async syncBranches(projectId: string): Promise<ProjectFilesBranchSyncResult> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        throw badRequest("Project is not a git checkout");
      }

      const repoRoot = summary.repoRoot;
      const details: ProjectFilesBranchSyncDetail[] = [];

      // Step 1: fetch --prune to update remote refs and mark gone upstreams
      try {
        await runGit(["fetch", "--prune", "origin"], repoRoot);
      } catch (error) {
        const errorMessage = sanitizeGitError(error, "Git fetch failed");
        const isAuthError = /auth|permission denied|could not read from remote repository|authentication/i.test(errorMessage);
        return {
          status: isAuthError ? "auth_error" : "error",
          details: [],
          summary: await buildSummary(project),
          message: errorMessage,
        };
      }

      // Step 2: inspect local branches with upstream tracking info
      // %(upstream:track) returns "[gone]" when upstream was pruned by fetch --prune
      let localRaw = "";
      try {
        localRaw = (
          await runGit(
            ["for-each-ref", "--format=%(refname:short)|%(upstream:short)|%(upstream:track)", "refs/heads"],
            repoRoot,
          )
        ).stdout;
      } catch {
        localRaw = "";
      }

      type LocalBranchInfo = { name: string; upstream: string | null; trackStatus: string };
      const localBranches: LocalBranchInfo[] = [];
      const localBranchNames = new Set<string>();

      for (const line of localRaw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        const name = parts[0] ?? "";
        const upstream = parts[1] || null;
        const trackStatus = parts[2] ?? "";
        if (!name) continue;
        localBranchNames.add(name);
        localBranches.push({ name, upstream, trackStatus });
      }

      // Step 3: inspect remote branches on origin (after prune, these are all live)
      let remoteRaw = "";
      try {
        remoteRaw = (
          await runGit(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], repoRoot)
        ).stdout;
      } catch {
        remoteRaw = "";
      }

      const remoteBranchNames = new Set<string>();
      for (const line of remoteRaw.split(/\r?\n/)) {
        const name = line.trim();
        // "origin" is the bare remote-tracking root ref, not a real branch — skip it
        if (!name || name === "origin/HEAD" || name === "origin") continue;
        const shortName = name.startsWith("origin/") ? name.slice("origin/".length) : name;
        if (!shortName) continue;
        remoteBranchNames.add(shortName);
      }

      // Step 4: process each local branch
      for (const local of localBranches) {
        // A branch named after the remote (e.g. "origin") collides with remote refs — skip it
        if (local.name === "origin") {
          details.push({
            branchName: local.name,
            action: "error",
            errorMessage: "Branch name 'origin' conflicts with the remote name — rename it: git branch -m origin <new-name>",
          });
          continue;
        }

        if (local.trackStatus.includes("[gone]")) {
          // Remote was deleted — try to auto-delete the local branch
          if (local.name === summary.currentBranch) {
            // Cannot delete the currently checked-out branch
            details.push({
              branchName: local.name,
              action: "remote_deleted_local_remains",
              errorMessage: "Cannot delete current branch — switch to another branch first",
            });
            continue;
          }
          try {
            await runGit(["branch", "-d", local.name], repoRoot);
            details.push({ branchName: local.name, action: "local_auto_deleted", errorMessage: null });
          } catch (error) {
            // -d refuses to delete branches with unmerged commits; surface as actionable message
            details.push({
              branchName: local.name,
              action: "remote_deleted_local_remains",
              errorMessage: sanitizeGitError(error, `Could not delete ${local.name} — may have unmerged commits`),
            });
          }
          continue;
        }

        if (!local.upstream) {
          // No upstream — branch only exists locally, not on origin. Delete it.
          if (local.name === summary.currentBranch) {
            details.push({
              branchName: local.name,
              action: "remote_deleted_local_remains",
              errorMessage: "Cannot delete current branch — switch to another branch first",
            });
            continue;
          }
          try {
            await runGit(["branch", "-d", local.name], repoRoot);
            details.push({ branchName: local.name, action: "local_auto_deleted", errorMessage: null });
          } catch (error) {
            details.push({
              branchName: local.name,
              action: "remote_deleted_local_remains",
              errorMessage: sanitizeGitError(error, `Could not delete ${local.name} — may have unmerged commits`),
            });
          }
          continue;
        }

        // Has valid upstream — fetch --prune already updated the ref
        details.push({ branchName: local.name, action: "already_in_sync", errorMessage: null });
      }

      // Step 5: create local tracking branches for remote-only branches
      for (const remoteName of remoteBranchNames) {
        if (!localBranchNames.has(remoteName)) {
          try {
            // Creates local tracking branch without checking it out (does not disturb working tree)
            await runGit(["branch", "--track", remoteName, `origin/${remoteName}`], repoRoot);
            details.push({ branchName: remoteName, action: "created_local_tracking", errorMessage: null });
          } catch (error) {
            details.push({
              branchName: remoteName,
              action: "error",
              errorMessage: sanitizeGitError(error, `Failed to create tracking branch for ${remoteName}`),
            });
          }
        }
      }

      // Step 6: determine overall status
      const hasGone = details.some((d) => d.action === "remote_deleted_local_remains");
      const hasError = details.some((d) => d.action === "error");
      const status: ProjectFilesBranchSyncResult["status"] = hasGone || hasError ? "partial" : "success";

      const syncedCount = details.filter(
        (d) => d.action === "pushed_to_remote" || d.action === "created_local_tracking" || d.action === "already_in_sync",
      ).length;
      const goneCount = details.filter((d) => d.action === "remote_deleted_local_remains").length;
      const errorCount = details.filter((d) => d.action === "error").length;

      const messageParts: string[] = [];
      if (syncedCount > 0) messageParts.push(`${syncedCount} branch${syncedCount !== 1 ? "es" : ""} in sync`);
      if (goneCount > 0) messageParts.push(`${goneCount} with deleted upstream${goneCount !== 1 ? "s" : ""}`);
      if (errorCount > 0) messageParts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);

      return {
        status,
        details,
        summary: await buildSummary(project),
        message: messageParts.join(", ") || null,
      };
    },

    async deleteBranch(projectId: string, name: string, force = false): Promise<ProjectFilesSummary> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        throw badRequest("Project is not a git checkout");
      }
      if (!name.trim()) throw badRequest("Branch name is required");
      if (name === summary.currentBranch) throw conflict("Cannot delete the currently checked-out branch");
      if (name === "origin") throw badRequest("Cannot delete branch named 'origin'");
      try {
        await runGit(["branch", force ? "-D" : "-d", name], summary.repoRoot);
      } catch (error) {
        throw conflict(sanitizeGitError(error, `Failed to delete branch ${name}`));
      }
      return buildSummary(project);
    },

    async getGitStatus(projectId: string): Promise<GitStatusResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) {
        return { entries: [] };
      }
      const output = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], summary.repoRoot)).stdout;
      const entries: GitStatusEntry[] = [];
      for (const line of output.split(/\r?\n/)) {
        if (!line) continue;
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        const rest = line.slice(3);
        let filePath = rest;
        let oldPath: string | null = null;
        if ((x === "R" || x === "C") && rest.includes(" -> ")) {
          const parts = rest.split(" -> ");
          oldPath = parts[0] ?? null;
          filePath = parts[1] ?? rest;
        }
        entries.push({
          path: filePath,
          oldPath,
          indexStatus: x,
          workingStatus: y,
          isStaged: x !== " " && x !== "?",
          isUnstaged: y !== " " && y !== "?",
          isUntracked: x === "?" && y === "?",
        });
      }
      return { entries };
    },

    async stageFiles(projectId: string, paths: string[]): Promise<GitStatusResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) throw badRequest("Project is not a git checkout");
      if (!paths.length) throw badRequest("At least one path is required");
      try {
        await runGit(["add", "--", ...paths], summary.repoRoot);
      } catch (error) {
        throw conflict(sanitizeGitError(error, "Failed to stage files"));
      }
      const result = await this.getGitStatus(projectId);
      return result;
    },

    async unstageFiles(projectId: string, paths: string[]): Promise<GitStatusResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) throw badRequest("Project is not a git checkout");
      if (!paths.length) throw badRequest("At least one path is required");
      try {
        await runGit(["restore", "--staged", "--", ...paths], summary.repoRoot);
      } catch (error) {
        throw conflict(sanitizeGitError(error, "Failed to unstage files"));
      }
      const result = await this.getGitStatus(projectId);
      return result;
    },

    async commitStaged(projectId: string, message: string): Promise<GitCommitResult> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) throw badRequest("Project is not a git checkout");
      const trimmedMessage = message.trim();
      if (!trimmedMessage) throw badRequest("Commit message is required");
      try {
        const result = await runGit(
          ["-c", "user.email=paperclip@local", "-c", "user.name=Paperclip", "commit", "-m", trimmedMessage],
          summary.repoRoot,
        );
        const shaMatch = result.stdout.match(/\[(?:[^\]]+)\s+([0-9a-f]{6,40})\]/);
        return { status: "success", message: null, sha: shaMatch?.[1] ?? null };
      } catch (error) {
        const msg = sanitizeGitError(error, "Commit failed");
        if (/nothing to commit/i.test(msg)) {
          return { status: "nothing_to_commit", message: msg, sha: null };
        }
        return { status: "error", message: msg, sha: null };
      }
    },

    async getFileDiff(projectId: string, filePath: string, staged: boolean): Promise<GitDiffResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) return { diff: "", path: filePath };
      const normalizedPath = normalizeRelativePath(filePath);
      try {
        const args = staged
          ? ["diff", "--staged", "--", normalizedPath]
          : ["diff", "--", normalizedPath];
        const result = await runGit(args, summary.repoRoot);
        return { diff: result.stdout, path: normalizedPath };
      } catch {
        return { diff: "", path: normalizedPath };
      }
    },

    async discardFiles(projectId: string, paths: string[]): Promise<GitStatusResponse> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) throw badRequest("Project is not a git checkout");
      if (!paths.length) throw badRequest("At least one path is required");

      const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], summary.repoRoot)).stdout;
      const untrackedPaths = new Set<string>();
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) untrackedPaths.add(line.slice(3).trim());
      }

      const trackedPaths = paths.filter((p) => !untrackedPaths.has(p));
      const untracked = paths.filter((p) => untrackedPaths.has(p));

      if (trackedPaths.length > 0) {
        try {
          await runGit(["restore", "--staged", "--worktree", "--", ...trackedPaths], summary.repoRoot);
        } catch {
          // some paths may not be staged — fall back to worktree-only restore
          try {
            await runGit(["restore", "--worktree", "--", ...trackedPaths], summary.repoRoot);
          } catch (error) {
            throw conflict(sanitizeGitError(error, "Failed to discard changes"));
          }
        }
      }

      for (const filePath of untracked) {
        const absPath = resolvePathWithinRoot(summary.repoRoot, filePath);
        await fs.rm(absPath, { recursive: true, force: true });
      }

      return await this.getGitStatus(projectId);
    },

    async pushFiles(projectId: string): Promise<GitPushResult> {
      const project = await ensureProject(projectId, db);
      const summary = await buildSummary(project);
      if (!summary.available || !summary.repoRoot) throw badRequest("Project is not a git checkout");
      try {
        await runGit(["push"], summary.repoRoot);
        return { status: "success", message: null };
      } catch (error) {
        const msg = sanitizeGitError(error, "Push failed");
        const isAuthError = /auth|permission denied|could not read from remote repository|authentication/i.test(msg);
        return { status: isAuthError ? "auth_error" : "error", message: msg };
      }
    },

    async publishToRemote(
      projectId: string,
      remoteUrl: string,
    ): Promise<{ status: "success" | "auth_error" | "error"; message: string | null }> {
      const project = await ensureProject(projectId, db);
      const rootPath = await resolveProjectRoot(project);
      if (!rootPath) {
        return { status: "error", message: "No local workspace available" };
      }

      try {
        try {
          await runGit(["remote", "get-url", "origin"], rootPath);
          await runGit(["remote", "set-url", "origin", remoteUrl], rootPath);
        } catch {
          await runGit(["remote", "add", "origin", remoteUrl], rootPath);
        }

        const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootPath);
        const branch = branchResult.stdout.trim();
        if (!branch || branch === "HEAD") {
          return { status: "error", message: "No commits on branch to push" };
        }

        await runGit(["push", "-u", "origin", branch], rootPath);
        return { status: "success", message: null };
      } catch (error) {
        const errorMessage = sanitizeGitError(error, "Failed to publish to remote");
        if (/auth|permission denied|could not read from remote repository|authentication/i.test(errorMessage)) {
          return { status: "auth_error", message: errorMessage };
        }
        return { status: "error", message: errorMessage };
      }
    },
  };
}
