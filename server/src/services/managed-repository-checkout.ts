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

export function managedCloneTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.min(Math.floor(raw), 2_147_483_647) : MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS;
}

export function managedCloneFilterArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.PAPERCLIP_MANAGED_CLONE_FILTER ?? "").trim();
  return /^(blob:none|blob:limit=\d+[kmg]?|tree:0)$/.test(raw) ? [`--filter=${raw}`] : [];
}

export function describeManagedCloneFailure(error: unknown, timeoutMs: number): string {
  const e = error as { killed?: boolean; signal?: string | null; stderr?: unknown; message?: string } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : Buffer.isBuffer(e?.stderr) ? e!.stderr.toString("utf8") : "";
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line && !/^Cloning into /.test(line));
  const causes = lines.filter((line) => /permission denied|could not resolve|connection refused|connection timed out|host key verification failed|fatal:|error:/i.test(line));
  const tail = (causes.length > 0 ? causes : lines.slice(-3)).join(" | ");
  if (e?.killed || e?.signal === "SIGTERM") {
    return `git clone timed out after ${Math.round(timeoutMs / 60_000)} min (set PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS for big repositories)${tail ? `; last git output: ${tail}` : ""}`;
  }
  if (tail) return `git clone failed: ${tail}`;
  return error instanceof Error ? error.message : String(error);
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
  const cloneTimeoutMs = managedCloneTimeoutMs();
  const filterArgs = input.localSource ? [] : managedCloneFilterArgs();
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
          [...(auth?.configArgs ?? []), ...(referencePath ? ["-c", "repack.updateServerInfo=false"] : []), "clone", "--no-hardlinks", ...(referencePath ? ["--reference-if-able", referencePath, "--dissociate"] : []), ...filterArgs, "--", cloneSource, cloneTmpDir],
          {
            env: {
              ...sanitizeRuntimeServiceBaseEnv(process.env),
              GIT_TERMINAL_PROMPT: "0",
              ...(auth?.env ?? {}),
            },
            timeout: cloneTimeoutMs,
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
      const cause = describeManagedCloneFailure(error, cloneTimeoutMs);
      const connectionFailure = !input.localSource ? classifyGitCloneFailure(input.repoUrl, error) : null;
      if (connectionFailure) throw new GitConnectionFailureError(cause, connectionFailure);
      if (error instanceof Error && !isWorkspaceGitScanError(error)) error.message = cause;
      throw error;
    }
    if (objectCache && !reference && filterArgs.length === 0) await measureRunPhase("workspace.checkout.cache_publish", () => publishRepositoryObjectCache(objectCache!, cloneTmpDir));
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
      await measureRunPhase("workspace.checkout.git_ref", () => execFile("git", [...(auth?.configArgs ?? []), "-C", cloneTmpDir, "checkout", input.repoRef!], {
        timeout: cloneTimeoutMs,
        env: { ...sanitizeRuntimeServiceBaseEnv(process.env), GIT_TERMINAL_PROMPT: "0", ...(auth?.env ?? {}) },
      }));
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
