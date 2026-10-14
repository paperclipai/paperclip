import path from "node:path";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TaskWorkspaceIntent } from "@paperclipai/shared";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";

const execFile = promisify(execFileCallback);

export function isolatedRemoteSourcePath(companyId: string, issueId: string): string {
  if ([companyId, issueId].some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid isolated repository source identity");
  }
  return path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources", companyId, issueId, "checkout");
}

export function recordedIsolatedRemoteSource(input: {
  companyId?: string;
  sourceIssueId: string | null;
  repoUrl: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const value = input.metadata?.isolatedRemoteSource;
  if (value === undefined) return null;
  const source = value as Record<string, unknown> | null;
  if (!source || source.schema !== "paperclip.isolated-remote-source.v1"
    || !input.companyId || !input.sourceIssueId || source.companyId !== input.companyId
    || source.issueId !== input.sourceIssueId || source.repoUrl !== input.repoUrl) {
    throw new Error("Recorded isolated repository source identity changed");
  }
  return isolatedRemoteSourcePath(input.companyId, input.sourceIssueId);
}

async function assertRemoteSourceIdentity(cwd: string, repoUrl: string) {
  const root = resolvePaperclipInstanceRoot();
  const canonicalCwd = await fs.realpath(cwd);
  if (canonicalCwd !== path.join(await fs.realpath(root), path.relative(root, cwd))) {
    throw new Error("Isolated repository source path changed");
  }
  const gitDir = path.join(canonicalCwd, ".git");
  const entry = await fs.lstat(gitDir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Isolated repository source Git storage changed");
  const options = { timeout: 10_000, maxBuffer: 16 * 1024 };
  const common = await execFile("git", ["-C", canonicalCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], options);
  if (common.stdout.trim() !== gitDir) throw new Error("Isolated repository source Git storage changed");
  const origin = await execFile("git", ["-C", canonicalCwd, "config", "--local", "--null", "--get-all", "remote.origin.url"], options);
  if (origin.stdout !== `${repoUrl}\0`) throw new Error("Isolated repository source identity changed");
}

export async function verifiedRecordedIsolatedRemoteSource(input: Parameters<typeof recordedIsolatedRemoteSource>[0]): Promise<string | null> {
  const cwd = recordedIsolatedRemoteSource(input);
  if (cwd) await assertRemoteSourceIdentity(cwd, input.repoUrl!);
  return cwd;
}

export function canIsolateRemoteWorkspaceSource(input: {
  error: unknown;
  repoUrl: string | null;
  reuseExisting: boolean;
  hasExistingWorkspace: boolean;
  selectedProjectWorkspaceId: string | null;
  selection: TaskWorkspaceIntent | null | undefined;
  strategy: Record<string, unknown>;
  trustPresetKind: string;
}): boolean {
  const error = input.error as { status?: unknown; message?: unknown } | null;
  const branchTemplate = input.strategy.branchTemplate;
  const selectsFixedBranch = typeof branchTemplate === "string" && branchTemplate.length > 0
    && !/\{\{\s*(?:issue\.(?:id|identifier|title)|slug)\s*\}\}/.test(branchTemplate);
  if (input.trustPresetKind !== "standard" || error?.status !== 403 || error.message !== "Task workspace access is no longer available"
    || input.reuseExisting || input.hasExistingWorkspace || input.strategy.existingBranch || selectsFixedBranch
    || (input.selection && !["project", "task_default"].includes(input.selection.source))
    || (input.selectedProjectWorkspaceId && (input.selection?.selection.kind !== "configured_source"
      || input.selection.selection.projectWorkspaceId !== input.selectedProjectWorkspaceId))) return false;
  if (!input.repoUrl) return false;
  try {
    const url = new URL(input.repoUrl);
    return ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password
      && (url.protocol === "ssh:" || !url.username);
  } catch { return false; }
}

export async function materializeIsolatedRemoteWorkspaceSource(input: {
  companyId: string;
  issueId: string;
  repoUrl: string;
  resolveGitAuth: GitRemoteAuthProvider;
}): Promise<string> {
  const cwd = isolatedRemoteSourcePath(input.companyId, input.issueId);
  const root = resolvePaperclipInstanceRoot();
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  let parent = canonicalRoot;
  for (const segment of ["isolated-repository-sources", input.companyId, input.issueId]) {
    parent = path.join(parent, segment);
    await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await fs.lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(parent) !== parent) {
      throw new Error("Isolated repository source path is not a private directory");
    }
  }
  const canonicalCwd = path.join(parent, "checkout");
  const entry = await fs.lstat(canonicalCwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Isolated repository source cannot be a symbolic link");
  }
  const result = await materializeManagedProjectWorkspace(canonicalCwd, {
    repoUrl: input.repoUrl, resolveGitAuth: input.resolveGitAuth,
  });
  if (result.warning) throw new Error("Isolated repository source is not a Git checkout");
  await assertRemoteSourceIdentity(cwd, input.repoUrl);
  return cwd;
}
