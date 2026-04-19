import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

interface GitExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function gitExec(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

/**
 * Ensure the vault directory exists and is a git repo.
 * If gitRemoteUrl is provided and the directory doesn't exist, clone it.
 * If it exists, pull latest changes.
 */
export async function ensureRepo(opts: {
  vaultPath: string;
  gitRemoteUrl: string;
  gitBranch: string;
}): Promise<{ cloned: boolean; pulled: boolean; error?: string }> {
  const { vaultPath, gitRemoteUrl, gitBranch } = opts;

  // Check if directory exists
  let dirExists = false;
  try {
    const stat = await fs.stat(vaultPath);
    dirExists = stat.isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists && gitRemoteUrl) {
    // Clone the repo
    const parentDir = path.dirname(vaultPath);
    const dirName = path.basename(vaultPath);
    await fs.mkdir(parentDir, { recursive: true });
    const result = await gitExec(["clone", "--branch", gitBranch, "--single-branch", gitRemoteUrl, dirName], parentDir);
    if (result.code !== 0) {
      return { cloned: false, pulled: false, error: `git clone failed: ${result.stderr}` };
    }
    return { cloned: true, pulled: false };
  }

  if (!dirExists) {
    // No remote URL and directory doesn't exist — create it
    await fs.mkdir(vaultPath, { recursive: true });
    await gitExec(["init"], vaultPath);
    return { cloned: false, pulled: false };
  }

  // Directory exists — check if it's a git repo
  const isGitRepo = await gitExec(["rev-parse", "--git-dir"], vaultPath);
  if (isGitRepo.code !== 0) {
    // Not a git repo, just use as-is for local vaults
    return { cloned: false, pulled: false };
  }

  if (gitRemoteUrl) {
    // Pull latest
    const pullResult = await gitExec(["pull", "--rebase", "origin", gitBranch], vaultPath);
    if (pullResult.code !== 0) {
      return {
        cloned: false,
        pulled: false,
        error: `git pull failed: ${pullResult.stderr}`,
      };
    }
    return { cloned: false, pulled: true };
  }

  return { cloned: false, pulled: false };
}

/**
 * Stage all changes, commit, and push to the remote.
 */
export async function commitAndPush(opts: {
  vaultPath: string;
  gitRemoteUrl: string;
  gitBranch: string;
  message: string;
}): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
  const { vaultPath, gitRemoteUrl, gitBranch, message } = opts;

  // Stage all changes
  const addResult = await gitExec(["add", "-A"], vaultPath);
  if (addResult.code !== 0) {
    return { committed: false, pushed: false, error: `git add failed: ${addResult.stderr}` };
  }

  // Check if there's anything to commit
  const statusResult = await gitExec(["status", "--porcelain"], vaultPath);
  if (!statusResult.stdout) {
    return { committed: false, pushed: false };
  }

  // Commit
  const commitResult = await gitExec(
    ["commit", "-m", message, "--author", "Paperclip Obsidian Sync <noreply@paperclip.ing>"],
    vaultPath,
  );
  if (commitResult.code !== 0) {
    return {
      committed: false,
      pushed: false,
      error: `git commit failed: ${commitResult.stderr}`,
    };
  }

  // Push if remote is configured
  if (gitRemoteUrl) {
    const pushResult = await gitExec(["push", "origin", gitBranch], vaultPath);
    if (pushResult.code !== 0) {
      return {
        committed: true,
        pushed: false,
        error: `git push failed: ${pushResult.stderr}`,
      };
    }
    return { committed: true, pushed: true };
  }

  return { committed: true, pushed: false };
}
