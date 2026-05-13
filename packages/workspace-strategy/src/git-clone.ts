import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRealizationRequest } from "./types.js";
import type { GitRunner } from "./git-runner.js";

export interface GitCredentials {
  username: string;
  password: string;
}

export interface GitCloneDeps {
  git: GitRunner;
  /**
   * Resolve git credentials for the request's repoUrl. Returning `null`
   * signals that the tenant policy has no `gitCredentialsSecretId`
   * configured (server returns 503 `not_configured`); in that case the
   * caller falls back to an unauthenticated clone, which is the correct
   * behaviour for public repositories and first-run deployments where
   * credentials have not been provisioned yet.
   *
   * Implementations should still throw on transient errors (network,
   * 500s) so the init container can fail-fast and retry, rather than
   * silently producing an unauthenticated clone of a private repo.
   */
  getGitCredentials(): Promise<GitCredentials | null>;
  logger?: { warn?: (obj: unknown, msg: string) => void };
}

export async function executeProjectPrimaryClone(
  request: WorkspaceRealizationRequest,
  root: string,
  deps: GitCloneDeps,
): Promise<void> {
  const { repoUrl, repoRef } = request.source;
  if (!repoUrl) {
    throw new Error(
      "executeWorkspaceStrategy: repoUrl is required for project_primary strategy",
    );
  }
  const ref = repoRef ?? "HEAD";

  const creds = await deps.getGitCredentials();
  if (!creds) {
    deps.logger?.warn?.(
      { repoUrl },
      "[workspace-strategy] git credentials not configured; attempting unauthenticated clone",
    );
  }
  // GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=/bin/true ensure git never blocks
  // waiting for credentials on tty when none are configured (public repo
  // path) or when the URL-injected creds are sufficient.
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };
  if (creds) {
    env.GIT_USERNAME = creds.username;
    env.GIT_PASSWORD = creds.password;
  }

  const isWarm = existsSync(join(root, ".git"));
  if (!isWarm) {
    // SECURITY (deferred follow-up): credentials embedded in the URL are
    // visible in /proc/[pid]/cmdline for the lifetime of the clone
    // subprocess. The proper fix is a GIT_ASKPASS helper script that
    // emits the credential, which requires packaging the script into the
    // workspace-init runtime image — out of scope for this PR.
    // Tracking: M3a Greptile P2 finding on git-clone.ts:34.
    const url = creds ? injectCreds(repoUrl, creds) : repoUrl;
    const r = await deps.git.run("git", ["clone", "--branch", ref, url, "."], {
      cwd: root,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git clone failed (${r.exitCode}): ${r.stderr}`);
    }
    return;
  }

  const fetched = await deps.git.run("git", ["fetch", "origin", ref], { cwd: root, env });
  if (fetched.exitCode !== 0) {
    throw new Error(`git fetch failed (${fetched.exitCode}): ${fetched.stderr}`);
  }
  const reset = await deps.git.run("git", ["reset", "--hard", `origin/${ref}`], {
    cwd: root,
    env,
  });
  if (reset.exitCode !== 0) {
    throw new Error(`git reset --hard origin/${ref} failed: ${reset.stderr}`);
  }
}

function injectCreds(url: string, creds: GitCredentials): string {
  if (!url.startsWith("https://")) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(creds.username);
  u.password = encodeURIComponent(creds.password);
  return u.toString();
}
