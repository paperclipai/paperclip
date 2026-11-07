import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { isTaskOwnedLocalWorkspace, recoveryGenerationSettled, workspaceHasOtherWriter } from "./fresh-workspace-continuation.js";
import { materializeIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";

const execFile = promisify(execFileCallback);
const gitOptions = { timeout: 120_000, maxBuffer: 1024 * 1024 };
const PRIOR_WORKSPACE_FILE_LIMIT = 50;

/** R2: a fresh attempt starts from committed files, so it must say where the
 * previous attempt's files are. The source directory is retained unmodified.
 * This names only a directory that reuse would also trust as a source: the
 * task's own local workspace, with a settled recovery generation and no other
 * writer. It reads Git status through the shared scan scheduler with optional
 * locks disabled, so it cannot change the index of the retained directory. */
export async function describeRetainedPriorWorkspace(db: Db, input: {
  companyId: string; issueId: string; sourceRunId: string; successorRunId: string; freshCwd: string;
}): Promise<NonNullable<ExecutionContinuationEnvelope["priorWorkspace"]> | null> {
  const [prior] = await db.select({ workspace: executionWorkspaces, source: { id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt } })
    .from(environmentLeases).innerJoin(executionWorkspaces, and(
      eq(executionWorkspaces.companyId, environmentLeases.companyId),
      eq(executionWorkspaces.id, environmentLeases.executionWorkspaceId),
    )).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, environmentLeases.companyId),
      eq(heartbeatRuns.id, environmentLeases.heartbeatRunId)))
    .where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.sourceRunId),
      eq(environmentLeases.provider, "local")))
    .limit(1);
  const workspace = prior?.workspace;
  if (!workspace?.cwd || !isTaskOwnedLocalWorkspace(workspace, input.issueId) ||
      path.resolve(workspace.cwd) === path.resolve(input.freshCwd)) return null;
  const holds = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${input.sourceRunId}`));
  if (holds.some(hold => !recoveryGenerationSettled(hold.evidence, input.sourceRunId))) return null;
  // A tree that another writer may still change is not a recovery source.
  if (await workspaceHasOtherWriter(db, { companyId: input.companyId, workspaceId: workspace.id,
    successorRunId: input.successorRunId, stoppedSource: prior.source })) return null;
  const stat = await lstat(workspace.cwd).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  const priorCwd = workspace.cwd;
  const scan = (args: string[], operation: string) => workspaceGitOperationScheduler.run({
    workspacePath: priorCwd, args, operation, cacheTtlMs: 0, bypassSingleFlight: true, timeoutMs: 15_000,
    maxStdoutBytes: 4 * 1024 * 1024, fairnessKeys: [`company:${input.companyId}`, `workspace:${workspace.id}`],
  }).then(result => result.stdout, () => null);
  const status = await scan(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "retry.prior_workspace_status");
  const head = status === null ? null : await scan(["symbolic-ref", "--quiet", "--short", "HEAD"], "retry.prior_workspace_branch");
  const changed = status === null ? [] : parsePorcelainZ(status);
  return { sourceRunId: input.sourceRunId, path: priorCwd, branchName: head?.trim() || workspace.branchName || null,
    changedFilesKnown: status !== null, changedFileCount: changed.length,
    changedFiles: changed.slice(0, PRIOR_WORKSPACE_FILE_LIMIT) };
}

/** Paths from `git status --porcelain=v1 -z`. A rename or copy in either status
 * column is followed by a separate entry holding its original path. */
export function parsePorcelainZ(status: string) {
  const changed: string[] = [];
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    changed.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return changed;
}

/** Seed from committed objects, never from a possibly changing old directory.
 * --no-local also prevents shared objects/hardlinks and copied Git authority.
 * The caller authorizes the source before calling this function. */
export async function materializeFreshWorkspaceSeed(input: {
  companyId: string; issueId: string; runId: string; sourceCwd: string; baseRef?: string | null; repoUrl?: string | null;
  beforeCopy?(sourceCwd: string, targetCwd: string): Promise<void>;
}) {
  const root = await materializeIsolatedTaskDirectory({
    companyId: input.companyId, issueId: input.issueId, attemptId: input.runId,
  });
  const destination = path.join(root, "workspace");
  const receiptPath = path.join(root, "seed.json");
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(destination) !== destination)
      throw new Error("Fresh workspace identity changed");
    const receiptStat = await lstat(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error("Fresh workspace seed receipt changed");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.runId !== input.runId || receipt.companyId !== input.companyId || receipt.issueId !== input.issueId)
      throw new Error("Fresh workspace seed receipt changed");
    return destination;
  }
  const staging = await mkdtemp(path.join(root, ".seed-"));
  try {
    await input.beforeCopy?.(input.sourceCwd, destination);
    const probe = await execFile("git", ["-C", input.sourceCwd, "rev-parse", "--git-dir"],
      { ...gitOptions, env: { ...process.env, LC_ALL: "C" } })
      .then(() => true, (error: { code?: number; stderr?: string }) => {
        if (error.code === 128 && error.stderr?.startsWith("fatal: not a git repository")) return false;
        // Permission, corruption and transport failures are not permission to
        // replace a recorded repository with an empty workspace.
        throw error;
      });
    let commit: string | null = null;
    if (probe) {
      const ref = input.baseRef || "HEAD";
      const resolved = await execFile("git", ["-C", input.sourceCwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], gitOptions);
      commit = resolved.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid fresh workspace seed commit");
      await execFile("git", ["clone", "--no-local", "--no-checkout", "--", input.sourceCwd, staging], gitOptions);
      await execFile("git", ["-C", staging, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], gitOptions);
      // The old local directory is not a publication target for this attempt.
      await execFile("git", ["-C", staging, "remote", "remove", "origin"], gitOptions);
      if (input.repoUrl) await execFile("git", ["-C", staging, "remote", "add", "origin", input.repoUrl], gitOptions);
    }
    await writeFile(receiptPath, JSON.stringify({
      schema: "paperclip.fresh-workspace-seed.v1", companyId: input.companyId,
      issueId: input.issueId, runId: input.runId, commit,
    }), { mode: 0o600 });
    await rename(staging, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
