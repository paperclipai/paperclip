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
import { measureRunPhase, recordRepositoryObjectCacheDetail } from "./execution-preparation-timing.js";
import { resolveRepositoryObjectCache, readRepositoryObjectCache, publishRepositoryObjectCache } from "./repository-object-cache.js";

const execFile = promisify(execFileCallback);
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** The requested branch, tag, or commit is absent from a complete fresh clone. */
export class RepositoryRefNotFoundError extends Error {
  constructor(message: string, readonly requestedRef: string) {
    super(message);
    this.name = "RepositoryRefNotFoundError";
  }
}

/**
 * True only when Git reported an unknown ref and the clone positively cannot
 * resolve it. `rev-parse --verify --quiet` exits 1 for an unknown name; any
 * other failure (auth, corruption, timeout) is not evidence of a missing ref.
 */
async function isMissingRef(cloneCwd: string, ref: string, checkoutError: unknown): Promise<boolean> {
  const stderr = String((checkoutError as { stderr?: unknown } | null)?.stderr ?? "");
  if (!/did not match any file\(s\) known to git|invalid reference/.test(stderr)) return false;
  for (const candidate of [`${ref}^{commit}`, `refs/remotes/origin/${ref}^{commit}`]) {
    const exitCode = await execFile("git", ["-C", cloneCwd, "rev-parse", "--verify", "--quiet", "--end-of-options", candidate], { timeout: 30_000 })
      .then(() => 0, (error: { code?: unknown }) => error.code);
    if (exitCode !== 1) return false;
  }
  return true;
}

export async function materializeManagedProjectWorkspace(
  cwd: string,
  input: {
    repoUrl: string | null;
    repoRef?: string | null;
    localSource?: string | null;
    resolveGitAuth?: GitRemoteAuthProvider | null;
    beforeCopy?: (cloneCwd: string) => Promise<void>;
    beforePublish?: (cloneCwd: string) => Promise<void>;
    stagingParent?: string;
    objectCacheCompanyDirectory?: string;
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

  const hasAdoptableGitDir = () => measureRunPhase("workspace.checkout.lookup", () =>
    fs
      .stat(path.resolve(cwd, ".git"))
      .then((entry) => entry.isDirectory())
      .catch(() => false));
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

  let auth = input.resolveGitAuth && !input.localSource
    ? await measureRunPhase("workspace.checkout.git_auth", () => input.resolveGitAuth!(input.repoUrl!))
    : null;
  const cloneTmpDir = await fs.mkdtemp(input.stagingParent
    ? path.join(input.stagingParent, `${path.basename(cwd)}.clone-`)
    : `${cwd}.clone-`);
  const cloneSource = input.localSource ?? input.repoUrl;
  let objectCache = input.objectCacheCompanyDirectory && !input.localSource
    ? await measureRunPhase("workspace.checkout.cache_lookup", async () => {
      const cache = await resolveRepositoryObjectCache(input.objectCacheCompanyDirectory!, input.repoUrl!, auth);
      if (!cache) recordRepositoryObjectCacheDetail({ outcome: "disabled" });
      return cache;
    }) : null;
  const reference = objectCache ? await measureRunPhase("workspace.checkout.cache_lookup", async () => {
    const cached = await readRepositoryObjectCache(objectCache!);
    recordRepositoryObjectCacheDetail({ outcome: cached ? "hit" : "miss" });
    return cached;
  }) : null;
  try {
    await input.beforeCopy?.(cloneTmpDir);
    try {
      const clone = (referencePath: string | null) => measureRunPhase("workspace.checkout.git_clone", () => {
        recordRepositoryObjectCacheDetail({ referenceSupplied: referencePath !== null });
        return execFile(
          "git",
          [...(auth?.configArgs ?? []), ...(referencePath ? ["-c", "repack.updateServerInfo=false"] : []), "clone", "--no-hardlinks", ...(referencePath ? ["--reference-if-able", referencePath, "--dissociate"] : []), "--", cloneSource, cloneTmpDir],
          {
            env: {
              ...sanitizeRuntimeServiceBaseEnv(process.env),
              GIT_TERMINAL_PROMPT: "0",
              ...(auth?.env ?? {}),
            },
            timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
          },
        );
      });
      try { await clone(reference); }
      catch (error) {
        if (!reference) throw error;
        for (const name of await fs.readdir(cloneTmpDir)) await fs.rm(path.join(cloneTmpDir, name), { recursive: true, force: true });
        objectCache = null;
        auth = input.resolveGitAuth ? await input.resolveGitAuth(input.repoUrl) : null;
        await clone(null);
      }
    } catch (error) {
      const connectionFailure = !input.localSource ? classifyGitCloneFailure(input.repoUrl, error) : null;
      if (connectionFailure) throw new GitConnectionFailureError(
        error instanceof Error ? error.message : "Git clone failed", connectionFailure,
      );
      throw error;
    }
    if (objectCache && !reference) await measureRunPhase("workspace.checkout.cache_publish", () => publishRepositoryObjectCache(objectCache!, cloneTmpDir));
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
      const repoRef = input.repoRef;
      try {
        await measureRunPhase("workspace.checkout.git_ref", () => execFile("git", ["-C", cloneTmpDir, "checkout", repoRef], {
          // Untranslated Git messages keep missing-ref classification locale independent.
          timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
        }));
      } catch (error) {
        // Only a ref that a complete fresh clone cannot resolve is a missing ref;
        // every other checkout failure keeps its original cause.
        if (!await isMissingRef(cloneTmpDir, repoRef, error)) throw error;
        throw new RepositoryRefNotFoundError(
          `Requested ref "${repoRef}" does not exist in the repository. Request the repository again with an existing branch, tag, or commit.`,
          repoRef,
        );
      }
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
    if (isWorkspaceGitScanError(error)) throw new WorkspaceGitScanError(error.code, message);
    if (error instanceof RepositoryRefNotFoundError) throw new RepositoryRefNotFoundError(message, error.requestedRef);
    const connectionFailure = readGitConnectionFailure(error);
    if (connectionFailure) throw new GitConnectionFailureError(message, connectionFailure);
    throw new Error(message);
  }

  try {
    await measureRunPhase("workspace.checkout.publish", () => fs.rename(cloneTmpDir, cwd));
  } catch (renameError) {
    await fs
      .rm(cloneTmpDir, { recursive: true, force: true })
      .catch(() => undefined);
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


export async function ensureManagedRepositoriesIgnored(cwd: string, options: { plainTaskDirectory?: boolean } = {}): Promise<void> {
  const gitEntry = await fs.lstat(path.join(cwd, ".git")).catch(() => null);
  if (!gitEntry) return;
  if (gitEntry.isSymbolicLink()) throw new Error("Workspace Git metadata must not be a symlink");
  let excludePath: string;
  try {
    const result = await execFile("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], {
      timeout: 10_000, env: { ...process.env, LC_ALL: "C" },
    });
    excludePath = path.resolve(cwd, result.stdout.trim());
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown };
    if (options.plainTaskDirectory && failure.code === 128 && failure.signal == null &&
        failure.stderr === "fatal: not a git repository (or any of the parent directories): .git\n" &&
        !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR) return;
    throw error;
  }
  const exclude = await fs.readFile(excludePath, "utf8").catch(() => "");
  if (!exclude.split(/\r?\n/).includes(`/${PROJECT_REPOSITORIES_DIR}/`)) {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.appendFile(excludePath, `\n/${PROJECT_REPOSITORIES_DIR}/\n`);
  }
}
