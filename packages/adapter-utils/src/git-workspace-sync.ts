import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

export const GIT_ARCHIVE_EXCLUDES = [".git", ".git/*"] as const;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    execFile(
      "git",
      ["-C", localDir, ...args],
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

export async function readGitWorkspaceSnapshot(localDir: string): Promise<GitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

export async function withShallowGitWorkspaceClone<T>(
  input: {
    localDir: string;
    snapshot: GitWorkspaceSnapshot;
  },
  fn: (cloneDir: string) => Promise<T>,
): Promise<T> {
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-workspace-"));
  const tempRef = `refs/paperclip/git-sync/import/${randomUUID()}`;
  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(cloneDir, ["init"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    await runLocalGit(cloneDir, ["fetch", "--depth=1", input.localDir, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    await runLocalGit(
      cloneDir,
      input.snapshot.branchName
        ? ["checkout", "--force", "-B", input.snapshot.branchName, "FETCH_HEAD"]
        : ["checkout", "--force", "--detach", "FETCH_HEAD"],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    await runLocalGit(cloneDir, ["reset", "--hard", input.snapshot.headCommit], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return await fn(cloneDir);
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createImportedGitRef(scope = "remote"): string {
  return `refs/paperclip/git-sync/imported/${scope}/${randomUUID()}`;
}

export function createRemoteGitExportRef(scope = "remote"): string {
  return `refs/paperclip/git-sync/export/${scope}/${randomUUID()}`;
}

export async function deleteLocalGitRef(input: {
  localDir: string;
  ref: string;
}): Promise<void> {
  await runLocalGit(input.localDir, ["update-ref", "-d", input.ref], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }).catch(() => undefined);
}

export async function fetchGitBundleIntoLocalRef(input: {
  localDir: string;
  bundlePath: string;
  exportRef: string;
  importedRef: string;
  baseSha: string;
}): Promise<string> {
  const bundleSize = (await fs.stat(input.bundlePath).catch(() => null))?.size ?? 0;
  if (bundleSize === 0) {
    return input.baseSha;
  }

  await runLocalGit(input.localDir, ["fetch", "--force", input.bundlePath, `${input.exportRef}:${input.importedRef}`], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const importedHead = await runLocalGit(input.localDir, ["rev-parse", input.importedRef], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return importedHead.stdout.trim();
}

export function buildRemoteGitDeltaBundleScript(input: {
  remoteDir: string;
  baseSha: string;
  exportRef: string;
  bundlePath: string;
  catBundle?: boolean;
  cleanupBundle?: boolean;
}): string {
  const remoteDir = shellQuote(input.remoteDir);
  const bundlePath = shellQuote(input.bundlePath);
  const exportRef = shellQuote(input.exportRef);
  const baseSha = shellQuote(input.baseSha);
  const cleanupParts = [
    `rm -f ${bundlePath}`,
    `git -C ${remoteDir} update-ref -d ${exportRef} >/dev/null 2>&1 || true`,
  ];
  return [
    "set -e",
    input.cleanupBundle ? `cleanup() { ${cleanupParts.join("; ")}; }` : "",
    input.cleanupBundle ? "trap cleanup EXIT" : "",
    `mkdir -p ${shellQuote(path.posix.dirname(input.bundlePath))}`,
    `rm -f ${bundlePath}`,
    `git -C ${remoteDir} cat-file -e ${baseSha}^{commit}`,
    `commit_count=$(git -C ${remoteDir} rev-list --count HEAD --not ${baseSha})`,
    'if [ "$commit_count" -gt 0 ]; then',
    `  git -C ${remoteDir} update-ref ${exportRef} HEAD`,
    `  git -C ${remoteDir} bundle create ${bundlePath} ${exportRef} --not ${baseSha} >/dev/null`,
    "else",
    `  : > ${bundlePath}`,
    "fi",
    input.catBundle ? `cat ${bundlePath}` : "",
  ].filter(Boolean).join("\n");
}

export async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => null);
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent remote git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip remote git sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent remote git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}
