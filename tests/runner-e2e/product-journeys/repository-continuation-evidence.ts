import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFileContent } from "../../../packages/shared/src/types/workspace-file-resource.js";

const execFile = promisify(execFileCallback);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface RepositoryBundleEvidence {
  bundleSha256: string;
  head: string;
  parent: string;
  changes: Array<{ status: string; path: string }>;
  files: Record<string, string>;
  sourceReadme: string;
}

/** Inspect actual Git objects. No checkout, remote fetch, hook, or repo script runs. */
export async function inspectRepositoryBundle(bytes: Buffer, input: { sourceCommit: string; files: string[] }): Promise<RepositoryBundleEvidence> {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit) || bytes.length < 32 || bytes.length > 262_144
    || !/^# v[23] git bundle\n/.test(bytes.subarray(0, 32).toString("ascii"))
    || input.files.some(file => !/^[A-Za-z0-9][A-Za-z0-9.-]{0,120}$/.test(file))) throw new Error("invalid_repository_bundle");
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-qa-repository-inspection-"));
  const gitDir = path.join(root, "objects.git"), bundle = path.join(root, "proof.bundle");
  const git = async (...args: string[]) => (await execFile("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "--git-dir", gitDir, ...args], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    timeout: 20_000, maxBuffer: 262_144, encoding: "utf8",
  })).stdout;
  try {
    await mkdir(gitDir);
    await writeFile(bundle, bytes, { mode: 0o600, flag: "wx" });
    await git("init", "--bare");
    await git("bundle", "verify", bundle);
    await git("fetch", "--no-tags", bundle, "HEAD:refs/heads/observed");
    await git("fsck", "--full", "--strict");
    const head = (await git("rev-parse", "refs/heads/observed")).trim();
    await git("merge-base", "--is-ancestor", input.sourceCommit, head);
    const parent = (await git("show", "-s", "--format=%P", head)).trim();
    // A merge or omitted parent cannot satisfy either single-commit turn.
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(parent)) throw new Error("repository_commit_parent_mismatch");
    const rawChanges = (await git("diff-tree", "--no-commit-id", "--name-status", "-r", "-z", parent, head)).split("\0");
    if (rawChanges.pop() !== "" || rawChanges.length % 2) throw new Error("repository_tree_changes_invalid");
    const changes = Array.from({ length: rawChanges.length / 2 }, (_, i) => ({ status: rawChanges[i * 2]!, path: rawChanges[i * 2 + 1]! }));
    const files: Record<string, string> = {};
    for (const file of input.files) files[file] = await git("show", `${head}:${file}`);
    return { bundleSha256: sha(bytes), head, parent, changes, files, sourceReadme: await git("show", `${input.sourceCommit}:README`) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export function repositoryWorkspaceFileMatches(value: WorkspaceFileContent | null, workspaceId: string, filename: string, bytes: string) {
  return Boolean(value && workspaceId && value.resource.kind === "file" && value.resource.workspaceKind === "execution_workspace"
    && value.resource.workspaceId === workspaceId && value.resource.title === filename
    && value.resource.byteSize === Buffer.byteLength(bytes) && value.content.encoding === "utf8" && value.content.data === bytes);
}

export function repositoryWorkspaceBindingMatches(input: {
  companyId: string; issueId: string; projectId: string; projectWorkspaceId: string; workspaceId: string; repoUrl: string;
  issue: Record<string, any>; view: Record<string, any>; runs: Array<Record<string, any>>;
}) {
  const { workspace } = input.view;
  return Boolean(input.workspaceId && input.issue.id === input.issueId && input.issue.companyId === input.companyId
    && input.issue.projectId === input.projectId && input.issue.executionWorkspaceId === input.workspaceId
    && input.view.issueId === input.issueId && workspace?.id === input.workspaceId && workspace.companyId === input.companyId
    && workspace.projectId === input.projectId && workspace.projectWorkspaceId === input.projectWorkspaceId
    && workspace.repoUrl === input.repoUrl && input.runs.length > 0
    && input.runs.every(run => run.companyId === input.companyId
      && run.runnerProfileJson?.nativeExecutionInput?.binding?.executionWorkspaceId === input.workspaceId));
}

export function repositoryCommitMatches(value: RepositoryBundleEvidence | null, expected: {
  parent: string; sourceReadme: string; files: Record<string, string>; added: string[];
}) {
  return Boolean(value && /^[a-f0-9]{40}$/.test(value.head) && value.head !== expected.parent
    && value.parent === expected.parent && value.sourceReadme === expected.sourceReadme
    && value.changes.length === expected.added.length && new Set(value.changes.map(change => change.path)).size === expected.added.length
    && value.changes.every(change => change.status === "A" && expected.added.includes(change.path))
    && Object.keys(value.files).length === Object.keys(expected.files).length
    && Object.entries(expected.files).every(([file, bytes]) => value.files[file] === bytes));
}
