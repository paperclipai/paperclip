import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_REPOSITORIES_DIR, readGitWorkspaceSnapshot, disposeGitWorkspaceSnapshot } from "@paperclipai/adapter-utils/git-workspace-sync";
import { captureDirectorySnapshot, disposeDirectorySnapshot, mergeDirectoryWithBaseline } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { sanitizeRuntimeServiceBaseEnv } from "./runtime-service-env.js";
import { describeGitAuthFailure, scrubGitCredentialText, type GitRemoteAuthProvider } from "./git-credentials.js";
import { classifyGitCloneFailure, GitConnectionFailureError, readGitConnectionFailure } from "./git-connection-failure.js";
import { isWorkspaceGitScanError, WorkspaceGitScanError } from "./workspace-git-operation-scheduler.js";

const execFile = promisify(execFileCallback);
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** Atomically publish a complete managed checkout; never delete a competing checkout. */
export async function materializeManagedProjectWorkspace(
  cwd: string,
  input: {
    repoUrl: string | null;
    repoRef?: string | null;
    localSource?: string | null;
    resolveGitAuth?: GitRemoteAuthProvider | null;
    /** Internal preparation receipt is committed inside the clone before atomic publication. */
    beforePublish?: (cloneCwd: string) => Promise<void>;
  },
): Promise<{ cwd: string; warning: string | null }> {
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const hasAdoptableGitDir = () =>
    fs
      .stat(path.resolve(cwd, ".git"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
  if (await hasAdoptableGitDir()) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  // Clone into a temp sibling, then move into place atomically. The shared target directory
  // is never created in a partial state and never removed on failure, so a concurrent
  // materialization (another process, or a run racing this one) can neither adopt a broken
  // checkout nor lose its own completed one.
  const auth = input.resolveGitAuth && !input.localSource
    ? await input.resolveGitAuth(input.repoUrl)
    : null;
  const cloneTmpDir = await fs.mkdtemp(`${cwd}.clone-`);
  try {
    try {
      await execFile(
        "git",
        [...(auth?.configArgs ?? []), "clone", "--no-hardlinks", "--", input.localSource ?? input.repoUrl, cloneTmpDir],
        {
          env: {
            // Spread order matters: the sanitizer strips PAPERCLIP_*, which would remove the
            // credential-helper token env if it came first. GIT_TERMINAL_PROMPT=0 fails a
            // credential-less private clone immediately instead of hanging on a prompt until
            // the clone timeout.
            ...sanitizeRuntimeServiceBaseEnv(process.env),
            GIT_TERMINAL_PROMPT: "0",
            ...(auth?.env ?? {}),
          },
          timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      const connectionFailure = !input.localSource ? classifyGitCloneFailure(input.repoUrl, error) : null;
      if (connectionFailure) throw new GitConnectionFailureError(
        error instanceof Error ? error.message : "Git clone failed", connectionFailure,
      );
      throw error;
    }
    if (input.localSource) {
      const snapshot = await readGitWorkspaceSnapshot(input.localSource, false);
      if (!snapshot) throw new Error("Configured repository folder is not a Git checkout");
      let baseline;
      try {
        baseline = await captureDirectorySnapshot(cloneTmpDir, { exclude: [".git", ".paperclip-runtime", PROJECT_REPOSITORIES_DIR], ignoredPaths: snapshot.ignoredPaths, diskBacked: true });
        await mergeDirectoryWithBaseline({ baseline, sourceDir: input.localSource, targetDir: cloneTmpDir });
      } finally {
        if (baseline) await disposeDirectorySnapshot(baseline);
        await disposeGitWorkspaceSnapshot(snapshot);
      }
      await execFile("git", ["-C", cloneTmpDir, "remote", "set-url", "origin", input.repoUrl], { timeout: 10_000 });
    } else if (input.repoRef) {
      await execFile("git", ["-C", cloneTmpDir, "checkout", input.repoRef], { timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS });
    }
    await input.beforePublish?.(cloneTmpDir);
  } catch (error) {
    await fs
      .rm(cloneTmpDir, { recursive: true, force: true })
      .catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    const authNote = describeGitAuthFailure({
      error: reason,
      used: auth ? { source: auth.source, secretName: auth.secretName } : null,
    });
    const message = scrubGitCredentialText(
      `Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}${authNote ? ` ${authNote}` : ""}`,
    );
    // Preserve the closed failure code without copying subprocess output or
    // credentials into the durable run. Setup recovery needs the actual cause.
    if (isWorkspaceGitScanError(error)) throw new WorkspaceGitScanError(error.code, message);
    const connectionFailure = readGitConnectionFailure(error);
    if (connectionFailure) throw new GitConnectionFailureError(message, connectionFailure);
    throw new Error(message);
  }

  try {
    await fs.rename(cloneTmpDir, cwd);
  } catch (renameError) {
    await fs
      .rm(cloneTmpDir, { recursive: true, force: true })
      .catch(() => undefined);
    // The target appearing between the emptiness check and the rename means another
    // materialization won the race; adopt its checkout instead of failing the run.
    if (await hasAdoptableGitDir()) {
      return { cwd, warning: null };
    }
    const reason =
      renameError instanceof Error ? renameError.message : String(renameError);
    throw new Error(
      `Failed to move managed checkout into place at "${cwd}": ${reason}`,
    );
  }
  return { cwd, warning: null };
}


/** The container is independently captured, never an accidental Git submodule.
 * A plain task root must not discover and mutate an ancestor repository. */
export async function ensureManagedRepositoriesIgnored(cwd: string): Promise<void> {
  const gitEntry = await fs.lstat(path.join(cwd, ".git")).catch(() => null);
  if (!gitEntry) return;
  if (gitEntry.isSymbolicLink()) throw new Error("Workspace Git metadata must not be a symlink");
  const excludePath = await execFile("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], { timeout: 10_000 })
    .then((result) => path.resolve(cwd, result.stdout.trim()));
  const exclude = await fs.readFile(excludePath, "utf8").catch(() => "");
  if (!exclude.split(/\r?\n/).includes(`/${PROJECT_REPOSITORIES_DIR}/`)) {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.appendFile(excludePath, `\n/${PROJECT_REPOSITORIES_DIR}/\n`);
  }
}
