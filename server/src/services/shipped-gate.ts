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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface RepoLocalPathResolver {
  (repo: string): string | null;
}

const DEFAULT_REPO_LOCAL_PATHS: Record<string, string> = {
  circaid: "/Users/ajinkya/Desktop/circaid-paperclip-pilot",
};

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
  const configured = loadConfiguredRepoLocalPaths();
  return configured[repo] ?? DEFAULT_REPO_LOCAL_PATHS[repo] ?? null;
}

const GIT_TIMEOUT_MS = 10_000;

// Three of the four call sites run this inside a DB transaction holding a
// locked issue row (routes/issues.ts recovery path, issue-thread-interactions
// completion review). A hung git process must not hold that lock forever --
// bound every call so the worst case is a bounded stall, not a wedged
// transaction / exhausted connection pool.
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout;
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
    await runGit(["cat-file", "-e", `${sha}^{commit}`], repoPath);
  } catch {
    throw unprocessable(
      `Shipped gate: commit ${sha} does not exist in ${repo} (${repoPath}) — this work product's claim does not check out`,
      { code: "shipped_gate_commit_not_found", workProductId: product.id, repo, sha },
    );
  }

  let actualFiles: string[];
  try {
    // Plain diff-tree reports no files for a merge commit (git diffs it
    // against nothing by default). Diff against the first parent instead so
    // a merge that actually carries changes still verifies correctly.
    const parentCount = (await runGit(["rev-list", "--parents", "-n", "1", sha], repoPath))
      .trim().split(/\s+/).length - 1;
    const stdout = parentCount > 1
      ? await runGit(["diff", "--no-commit-id", "--name-only", "-r", `${sha}^1`, sha], repoPath)
      : await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repoPath);
    actualFiles = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
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
  const commitProducts = input.workProducts.filter((product) => product.type === "commit");
  if (commitProducts.length === 0) return;
  const resolveRepoLocalPath = input.resolveRepoLocalPath ?? defaultResolveRepoLocalPath;
  for (const product of commitProducts) {
    await verifyCommitWorkProduct(product, resolveRepoLocalPath);
  }
}
