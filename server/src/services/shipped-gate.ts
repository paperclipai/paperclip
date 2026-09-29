// Deterministic "shipped" gate (CIR-39): an issue that carries a commit-type
// work product cannot transition to "done" unless the claimed commit really
// exists in the named repo. When the work product also lists the files it
// claims to touch (metadata.files), the real diff must match exactly; when
// it only carries a changedFiles count (the only thing any current creation
// path populates), the real diff's file count must match instead. This runs
// at the same executionPolicy.stages boundary in routes/issues.ts that
// CIR-34's own spike proved cannot be bypassed by a direct status PATCH — it
// is not a cooperative checklist item an agent can skip.
//
// Scope (approved 2026-09-10, CIR-39 plan): fires only on issues that already
// carry a "commit" work product — no gate, no claim, nothing to verify.
import type { IssueWorkProduct } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  isWorkspaceGitScanError,
  WORKSPACE_GIT_SCAN_ERROR_CODES,
  workspaceGitOperationScheduler,
} from "./workspace-git-operation-scheduler.js";

export interface RepoLocalPathResolver {
  (repo: string): string | null;
}

function loadConfiguredRepoLocalPaths(): Record<string, string> {
  const raw = process.env.SHIPPED_GATE_REPO_PATHS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return Object.fromEntries(entries);
    }
  } catch {
    // Malformed env override: fall through to defaults rather than crash a request path.
  }
  return {};
}

export function defaultResolveRepoLocalPath(repo: string): string | null {
  // Exact match only. metadata.repo is stored as either a bare name
  // ("circaid") or a GitHub "owner/repo" slug (see work-products.ts /
  // github-commit-details.ts) -- matching only on the trailing segment would
  // let a same-named-but-different repo ("someotherorg/circaid") resolve to
  // this instance's real circaid checkout and get verified against the
  // wrong history. Operators must configure SHIPPED_GATE_REPO_PATHS with
  // whichever exact string metadata.repo actually uses.
  //
  // No baked-in default: an absolute path on one contributor's machine is
  // not a portable default for any other installation. Every deployment,
  // including this one, must set SHIPPED_GATE_REPO_PATHS explicitly.
  return loadConfiguredRepoLocalPaths()[repo] ?? null;
}

const GIT_TIMEOUT_MS = 10_000;

// Statuses that mark a work product as no longer the live claim for its
// issue. Combined with isPrimary in assertShippedGate below.
const TERMINAL_WORK_PRODUCT_STATUSES = new Set(["failed", "archived", "closed"]);

// Routed through the process-wide workspace Git scheduler (already used by
// the file-browser diff paths) instead of spawning ad hoc child processes.
// Three of the four call sites run this inside a DB transaction holding a
// locked issue row (routes/issues.ts recovery path, issue-thread-interactions
// completion review) -- a burst of completions must not be able to recreate
// unbounded child-process pressure, and a hung git process must not hold
// that lock forever. cacheTtlMs is 0: this is a correctness gate, not a file
// browser, and must never serve a cached answer for a different commit.
async function runGit(args: string[], cwd: string, repo: string): Promise<string> {
  const result = await workspaceGitOperationScheduler.run({
    workspacePath: cwd,
    args,
    operation: "shipped_gate_verify",
    fairnessKeys: [`shipped-gate-repo:${repo}`],
    cacheTtlMs: 0,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.stdout;
}

// A saturated queue, a timeout, an output-limit trip, or a cancellation are
// scheduler-operational conditions, not evidence about the commit itself --
// retrying later can succeed. Only a real git failure (unknown revision,
// corrupt object, exit code != 0) means the claim doesn't check out. Without
// this distinction every operational hiccup reads as "commit not found" and
// permanently blocks a valid completion instead of surfacing as retryable.
function isSchedulerOperationalError(error: unknown): boolean {
  if (!isWorkspaceGitScanError(error)) return false;
  return (
    error.code === WORKSPACE_GIT_SCAN_ERROR_CODES.saturated ||
    error.code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout ||
    error.code === WORKSPACE_GIT_SCAN_ERROR_CODES.outputLimit ||
    error.code === WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled
  );
}

function normalizeFileList(files: unknown): string[] | null {
  if (!Array.isArray(files)) return null;
  const normalized = files.filter((value): value is string => typeof value === "string" && value.length > 0);
  return normalized.length === files.length ? normalized : null;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

async function verifyCommitWorkProduct(
  product: IssueWorkProduct,
  resolveRepoLocalPath: RepoLocalPathResolver,
): Promise<void> {
  const metadata = (product.metadata ?? {}) as Record<string, unknown>;
  const repo = typeof metadata.repo === "string" ? metadata.repo : null;
  const sha = typeof metadata.sha === "string" ? metadata.sha : null;
  const claimedFiles = normalizeFileList(metadata.files);

  if (!repo || !sha) {
    throw unprocessable(
      `Shipped gate: commit work product "${product.title}" is missing a repo or commit sha and cannot be verified`,
      { code: "shipped_gate_missing_commit_reference", workProductId: product.id },
    );
  }

  const repoPath = resolveRepoLocalPath(repo);
  if (!repoPath) {
    throw unprocessable(
      `Shipped gate: no local repo path is configured for "${repo}" — cannot verify commit ${sha}`,
      { code: "shipped_gate_unresolvable_repo", workProductId: product.id, repo },
    );
  }

  try {
    await runGit(["cat-file", "-e", `${sha}^{commit}`], repoPath, repo);
  } catch (error) {
    if (isSchedulerOperationalError(error)) throw error;
    throw unprocessable(
      `Shipped gate: commit ${sha} does not exist in ${repo} (${repoPath}) — this work product's claim does not check out`,
      { code: "shipped_gate_commit_not_found", workProductId: product.id, repo, sha },
    );
  }

  let actualFiles: string[];
  try {
    // Plain diff-tree reports no files for a merge commit (git diffs it
    // against nothing by default) and, separately, for a root commit (no
    // parent to diff against unless --root is passed) -- both would
    // otherwise read as "touched nothing" and fail every real claim against
    // it. Diff against the first parent for a merge; pass --root for a
    // root commit; plain diff-tree otherwise.
    const parentCount = (await runGit(["rev-list", "--parents", "-n", "1", sha], repoPath, repo))
      .trim().split(/\s+/).length - 1;
    const stdout = parentCount > 1
      ? await runGit(["diff", "--no-commit-id", "--name-only", "-r", `${sha}^1`, sha], repoPath, repo)
      : parentCount === 0
        ? await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], repoPath, repo)
        : await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repoPath, repo);
    actualFiles = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if (isSchedulerOperationalError(error)) throw error;
    throw unprocessable(
      `Shipped gate: could not read the diff for commit ${sha} in ${repo} — this work product's claim does not check out`,
      { code: "shipped_gate_diff_unreadable", workProductId: product.id, repo, sha },
    );
  }

  if (claimedFiles) {
    // Explicit per-file claim: exact match, the strictest check available.
    if (!setsEqual(claimedFiles, actualFiles)) {
      throw unprocessable(
        `Shipped gate: commit ${sha} in ${repo} touches different files than this work product claims — claimed [${claimedFiles.join(", ")}], actual [${actualFiles.join(", ")}]`,
        { code: "shipped_gate_file_mismatch", workProductId: product.id, repo, sha, claimedFiles, actualFiles },
      );
    }
    return;
  }

  // No caller today populates metadata.files (GitHub's per-commit file list
  // and the local run-diff-summary path only ever surface a count). Falling
  // back to a hard failure here would block every real commit work product
  // from ever reaching "done", which is worse than the gap this gate exists
  // to close. Fall back to the changedFiles count, which every existing
  // creation path already sets — still catches "commit doesn't exist" and
  // "diff size doesn't match what was claimed" without requiring a claim
  // shape nothing produces yet.
  const claimedCount = typeof metadata.changedFiles === "number" ? metadata.changedFiles : null;
  if (claimedCount === null) {
    // No file-level claim and no count either: a bare {repo, sha} is not a
    // verifiable claim, just an assertion. Failing closed here is the whole
    // point of this gate -- an unrelated-but-real commit sha must not be
    // enough to pass.
    throw unprocessable(
      `Shipped gate: commit work product "${product.title}" carries no diff evidence (no files list, no changedFiles count) — a bare commit sha is not a verifiable claim`,
      { code: "shipped_gate_missing_diff_evidence", workProductId: product.id },
    );
  }
  if (claimedCount !== actualFiles.length) {
    throw unprocessable(
      `Shipped gate: commit ${sha} in ${repo} touched ${actualFiles.length} file(s), but this work product claims ${claimedCount}`,
      { code: "shipped_gate_file_count_mismatch", workProductId: product.id, repo, sha, claimedCount, actualCount: actualFiles.length },
    );
  }
}

export async function assertShippedGate(input: {
  workProducts: IssueWorkProduct[];
  resolveRepoLocalPath?: RepoLocalPathResolver;
}): Promise<void> {
  // listForIssue returns every commit work product ever attached to the
  // issue, including ones a later commit superseded (status "failed",
  // "closed", "archived"). Verifying those alongside the current one means a
  // stale/replaced commit can block a done transition the current, valid
  // commit would pass on its own. Only the current, live claim is actually
  // being made right now -- verify that one.
  //
  // "Current" is NOT isPrimary: the public work-product creation contract
  // defaults isPrimary to false and nothing promotes a commit work product
  // to primary on creation, so filtering on isPrimary alone would skip
  // verification for the common case -- every commit work product created
  // through the default request shape. Use recency instead: among the
  // non-terminal commit work products, the one most recently written is the
  // live claim. This still fixes the obsolete-commit case (a superseded
  // claim has an older updatedAt) without depending on a flag nothing sets.
  const eligible = input.workProducts.filter(
    (product) => product.type === "commit" && !TERMINAL_WORK_PRODUCT_STATUSES.has(product.status),
  );
  if (eligible.length === 0) return;
  const current = eligible.reduce((latest, product) =>
    product.updatedAt.getTime() > latest.updatedAt.getTime() ? product : latest
  );
  const resolveRepoLocalPath = input.resolveRepoLocalPath ?? defaultResolveRepoLocalPath;
  await verifyCommitWorkProduct(current, resolveRepoLocalPath);
}
