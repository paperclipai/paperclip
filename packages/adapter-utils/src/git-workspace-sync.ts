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
  overlayPaths: string[];
  deletedPaths: string[];
  ignoredPaths: string[];
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

    const [headCommitResult, branchResult, overlayDiffResult, untrackedResult, deletedResult, ignoredResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", "HEAD", "--"], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--others", "--exclude-standard", "-z"], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      runLocalGit(localDir, ["diff", "--name-only", "-z", "--diff-filter=D", "HEAD", "--"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
      runLocalGit(localDir, ["status", "--ignored", "--porcelain=v1", "-z", "--untracked-files=normal"], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    const splitNul = (value: string) => value.split("\0").map((entry) => entry.trim()).filter(Boolean);
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      overlayPaths: [...new Set([...splitNul(overlayDiffResult.stdout), ...splitNul(untrackedResult.stdout)])]
        .sort((left, right) => left.localeCompare(right)),
      deletedPaths: [...new Set(splitNul(deletedResult.stdout))]
        .sort((left, right) => left.localeCompare(right)),
      ignoredPaths: splitNul(ignoredResult.stdout)
        .filter((entry) => entry.startsWith("!! "))
        .map((entry) => entry.slice(3).replace(/\/+$/, ""))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    };
  } catch {
    return null;
  }
}

// scp-like ssh remote (`user@host:path`). The syntax has no password slot, so
// it cannot embed a secret. Conservative shape: exactly one `@`, no colon in
// the user segment (a colon there could smuggle credential-looking material),
// no scheme separator (a `://` form parses as a URL and never reaches this).
const SCP_LIKE_REMOTE_PATTERN = /^[^@:/\s]+@[^@:/\s]+:\S+$/;

/**
 * Reduce a git remote URL to a credential-free form before it is copied into a
 * transported workspace, or null when the URL must not be carried at all.
 * Allowlist, fail closed: only shapes whose credential surface is fully known
 * are kept — http(s) with userinfo/query/fragment stripped (tokens ride in any
 * of those), ssh/git schemes with password/query/fragment stripped, and
 * scp-like `user@host:path` (no password slot exists in that syntax). Every
 * other form — filesystem paths, unknown schemes, unparseable strings — is
 * dropped rather than risk persisting an embedded secret in the execution
 * host's git config.
 */
export function sanitizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    if (parsed.protocol === "ssh:" || parsed.protocol === "git:" || parsed.protocol === "git+ssh:") {
      // The username (conventionally `git`) is addressing, not a secret; a
      // password or query string can be, so those are stripped.
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    return null;
  } catch {
    return SCP_LIKE_REMOTE_PATTERN.test(trimmed) ? trimmed : null;
  }
}

/**
 * The workspace's `origin` remote URL with credentials scrubbed, or null when
 * the workspace has no `origin` remote (or is not a git repository).
 */
export async function readSanitizedOriginRemoteUrl(localDir: string): Promise<string | null> {
  try {
    const result = await runLocalGit(localDir, ["remote", "get-url", "origin"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return sanitizeGitRemoteUrl(result.stdout.trim());
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
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(cloneDir, ["init"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (originUrl) {
      // The clone is what lands in the sandbox. Without `origin`, the branch
      // there reads as an unpublishable root snapshot even though its head is a
      // commit the upstream remote already holds — so fetch (to reconnect
      // ancestry) and push (to publish the branch; the shallow boundary commit
      // is already on the remote, so the pack closes) are both mechanically
      // possible once the remote is carried over. Best-effort: a failure to
      // record the remote must not fail the transport.
      await runLocalGit(cloneDir, ["remote", "add", "origin", originUrl], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
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

/** Substrings git emits when a bundle names a prerequisite the importer lacks. */
const GIT_MISSING_PREREQUISITE_MARKERS = [
  "did not send all necessary objects",
  "lacks these prerequisite commits",
  "revision walk setup failed",
];

/**
 * True when a bundle import failed because the host repository does not hold a
 * commit the (delta) bundle assumes as a prerequisite. Such a failure is
 * recoverable by re-exporting a full, self-contained bundle from the still-live
 * sandbox rather than discarding the run.
 */
export function isMissingGitPrerequisiteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_MISSING_PREREQUISITE_MARKERS.some((marker) => message.includes(marker));
}

export function buildRemoteGitDeltaBundleScript(input: {
  remoteDir: string;
  baseSha: string;
  exportRef: string;
  bundlePath: string;
  statusPath?: string;
  catBundle?: boolean;
  cleanupBundle?: boolean;
  /**
   * Skip the delta boundary entirely and always emit a full, self-contained
   * bundle (no prerequisites). Used as the recovery path when a delta import
   * failed because the host lacked the bundle's prerequisite.
   */
  forceFullBundle?: boolean;
}): string {
  const remoteDir = shellQuote(input.remoteDir);
  const bundlePath = shellQuote(input.bundlePath);
  const exportRef = shellQuote(input.exportRef);
  const baseSha = shellQuote(input.baseSha);
  const statusPath = input.statusPath ? shellQuote(input.statusPath) : null;
  const cleanupParts = [
    `rm -f ${bundlePath}`,
    ...(statusPath ? [`rm -f ${statusPath}`] : []),
    `git -C ${remoteDir} update-ref -d ${exportRef} >/dev/null 2>&1 || true`,
  ];
  return [
    "set -e",
    input.cleanupBundle ? `cleanup() { ${cleanupParts.join("; ")}; }` : "",
    input.cleanupBundle ? "trap cleanup EXIT" : "",
    `mkdir -p ${shellQuote(path.posix.dirname(input.bundlePath))}`,
    `rm -f ${bundlePath}`,
    // Choose the bundle boundary. A thin bundle `HEAD --not <baseSha>` records
    // baseSha as a prerequisite the importer (host) must already hold. That
    // assumption breaks in two real cases, and then `git fetch` on the host
    // hard-fails with "did not send all necessary objects" and the run's work
    // is lost:
    //   1. The sandbox HEAD has diverged from baseSha (e.g. a local-only branch
    //      that forked from an older commit) — the host may still hold baseSha,
    //      but a repo whose history is inconsistent cannot satisfy the walk.
    //   2. The host workspace no longer holds baseSha at import time (a shared
    //      workspace that was reset/re-realized between export and import).
    // Bundle relative to the merge-base of baseSha and HEAD instead: that
    // merge-base is an ancestor of baseSha, so any host that holds baseSha (or
    // an ancestor of it) can satisfy the prerequisite, while the bundle stays a
    // delta. When baseSha is absent from the sandbox — or no merge-base exists,
    // or the caller forces it after a delta import failed on a missing
    // prerequisite — fall back to a full, self-contained bundle with no
    // prerequisites.
    ...(input.forceFullBundle
      ? [`bundle_base=""`]
      : [
        `if git -C ${remoteDir} cat-file -e ${baseSha}^{commit} 2>/dev/null; then`,
        `  bundle_base=$(git -C ${remoteDir} merge-base ${baseSha} HEAD 2>/dev/null || true)`,
        "else",
        `  bundle_base=""`,
        "fi",
      ]),
    `if [ -n "$bundle_base" ]; then`,
    `  commit_count=$(git -C ${remoteDir} rev-list --count HEAD --not "$bundle_base")`,
    "else",
    `  commit_count=$(git -C ${remoteDir} rev-list --count HEAD)`,
    "fi",
    'if [ "$commit_count" -gt 0 ]; then',
    `  git -C ${remoteDir} update-ref ${exportRef} HEAD`,
    `  if [ -n "$bundle_base" ]; then`,
    `    git -C ${remoteDir} bundle create ${bundlePath} ${exportRef} --not "$bundle_base" >/dev/null`,
    "  else",
    `    git -C ${remoteDir} bundle create ${bundlePath} ${exportRef} >/dev/null`,
    "  fi",
    "else",
    `  : > ${bundlePath}`,
    "fi",
    statusPath
      ? [
        `if [ -z "$(git -C ${remoteDir} status --porcelain=v1 --untracked-files=normal)" ]; then`,
        `  printf clean > ${statusPath}`,
        "else",
        `  printf dirty > ${statusPath}`,
        "fi",
      ].join("\n")
      : "",
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

export async function resetLocalGitIndexToHead(input: {
  localDir: string;
  checkWorkingTreeClean?: boolean;
}): Promise<void> {
  try {
    await runLocalGit(input.localDir, ["reset", "--quiet", "HEAD", "--", "."], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = error && typeof error === "object"
      ? [
        (error as { message?: unknown }).message,
        (error as { stderr?: unknown }).stderr,
        (error as { stdout?: unknown }).stdout,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n")
      : String(error);
    throw new Error(`Failed to reset local git index to HEAD after workspace restore: ${detail}`);
  }

  const stagedDiff = await runLocalGit(input.localDir, ["diff", "--cached", "--name-status", "HEAD", "--"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (stagedDiff.stdout.trim().length > 0) {
    throw new Error(
      `Workspace restore left staged git index changes after reset:\n${stagedDiff.stdout.trim()}`,
    );
  }

  if (!input.checkWorkingTreeClean) return;

  const workingTreeDiff = await runLocalGit(input.localDir, ["diff", "--name-status", "HEAD", "--"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (workingTreeDiff.stdout.trim().length > 0) {
    console.warn(
      "[paperclip] Workspace restore preserved local working tree changes after clean sandbox restore.",
    );
  }
}
