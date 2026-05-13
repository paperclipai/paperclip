import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRealizationRequest } from "./types.js";
import type { GitRunner } from "./git-runner.js";
import type { GitCredentials } from "./git-clone.js";

export interface GitWorktreeDeps {
  git: GitRunner;
  /** See {@link GitCloneDeps.getGitCredentials} — same null-on-not_configured contract. */
  getGitCredentials(): Promise<GitCredentials | null>;
  logger?: { warn?: (obj: unknown, msg: string) => void };
}

export async function executeGitWorktree(
  request: WorkspaceRealizationRequest,
  root: string,
  deps: GitWorktreeDeps,
): Promise<void> {
  const { repoUrl, repoRef, worktreePath } = request.source;
  if (!repoUrl) {
    throw new Error(
      "executeWorkspaceStrategy: repoUrl is required for git_worktree strategy",
    );
  }
  const ref = repoRef ?? "HEAD";
  const worktreeName = worktreePath ?? "default";

  const creds = await deps.getGitCredentials();
  if (!creds) {
    deps.logger?.warn?.(
      { repoUrl },
      "[workspace-strategy] git credentials not configured; attempting unauthenticated clone",
    );
  }
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };
  if (creds) {
    env.GIT_USERNAME = creds.username;
    env.GIT_PASSWORD = creds.password;
  }
  const bareDir = join(root, ".bare");
  const worktreeDir = join(root, worktreeName);

  if (!existsSync(bareDir)) {
    // SECURITY (deferred follow-up): see git-clone.ts injectCreds() note —
    // URL-embedded credentials are visible in /proc/[pid]/cmdline.
    const url = creds ? injectCreds(repoUrl, creds) : repoUrl;
    const r = await deps.git.run("git", ["clone", "--bare", url, bareDir], { env });
    if (r.exitCode !== 0) {
      throw new Error(`git clone --bare failed: ${r.stderr}`);
    }
  } else {
    const r = await deps.git.run("git", ["fetch", "origin"], { cwd: bareDir, env });
    if (r.exitCode !== 0) {
      throw new Error(`git fetch failed: ${r.stderr}`);
    }
  }

  if (!existsSync(worktreeDir)) {
    const r = await deps.git.run("git", ["worktree", "add", "-f", worktreeDir, ref], {
      cwd: bareDir,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${r.stderr}`);
    }
  } else {
    const r = await deps.git.run("git", ["reset", "--hard", `origin/${ref}`], {
      cwd: worktreeDir,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git reset --hard failed: ${r.stderr}`);
    }
  }
}

function injectCreds(url: string, creds: GitCredentials): string {
  if (!url.startsWith("https://")) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(creds.username);
  u.password = encodeURIComponent(creds.password);
  return u.toString();
}
