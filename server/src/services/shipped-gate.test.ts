import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { assertShippedGate } from "./shipped-gate.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeCommitProduct(overrides: Partial<IssueWorkProduct> & { metadata?: Record<string, unknown> }): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "commit",
    provider: "github",
    externalId: null,
    title: "test commit",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {},
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("assertShippedGate", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "shipped-gate-test-"));
    git(repoPath, ["init", "-q"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "Test"]);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  function resolveToRepo() {
    return (repo: string) => (repo === "testrepo" ? repoPath : null);
  }

  function commitFiles(files: Record<string, string>, message: string): string {
    for (const [name, content] of Object.entries(files)) {
      const full = join(repoPath, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-q", "-m", message]);
    return git(repoPath, ["rev-parse", "HEAD"]).trim();
  }

  it("passes when a valid commit's file list matches the claim exactly", async () => {
    commitFiles({ "seed.ts": "0" }, "seed commit");
    const sha = commitFiles({ "a.ts": "1", "b.ts": "2" }, "add files");
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha, files: ["a.ts", "b.ts"] },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).resolves.toBeUndefined();
  });

  it("fails when the claimed file list does not match the actual diff", async () => {
    commitFiles({ "seed.ts": "0" }, "seed commit");
    const sha = commitFiles({ "a.ts": "1", "b.ts": "2" }, "add files");
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha, files: ["a.ts", "c.ts"] },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_file_mismatch" },
    });
  });

  it("fails when repo or sha is missing from metadata", async () => {
    const missingRepo = makeCommitProduct({ metadata: { sha: "deadbeef", files: ["a.ts"] } });
    await expect(assertShippedGate({ workProducts: [missingRepo], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_missing_commit_reference" },
    });

    const missingSha = makeCommitProduct({ metadata: { repo: "testrepo", files: ["a.ts"] } });
    await expect(assertShippedGate({ workProducts: [missingSha], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_missing_commit_reference" },
    });
  });

  it("fails when the repo cannot be resolved to a local path", async () => {
    const product = makeCommitProduct({
      metadata: { repo: "unknown-repo", sha: "deadbeef", files: ["a.ts"] },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_unresolvable_repo" },
    });
  });

  it("fails when the commit sha does not exist in the resolved repo", async () => {
    commitFiles({ "a.ts": "1" }, "seed commit so repo has history");
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha: "0000000000000000000000000000000000dead", files: ["a.ts"] },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_commit_not_found" },
    });
  });

  it("fails closed for a bare commit with neither files nor changedFiles", async () => {
    const sha = commitFiles({ "a.ts": "1" }, "add file");
    const product = makeCommitProduct({ metadata: { repo: "testrepo", sha } });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_missing_diff_evidence" },
    });
  });

  it("passes via the changedFiles-count fallback when the count matches", async () => {
    commitFiles({ "seed.ts": "0" }, "seed commit");
    const sha = commitFiles({ "a.ts": "1", "b.ts": "2" }, "add two files");
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha, changedFiles: 2 },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).resolves.toBeUndefined();
  });

  it("fails via the changedFiles-count fallback when the count mismatches", async () => {
    commitFiles({ "seed.ts": "0" }, "seed commit");
    const sha = commitFiles({ "a.ts": "1", "b.ts": "2" }, "add two files");
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha, changedFiles: 5 },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      details: { code: "shipped_gate_file_count_mismatch" },
    });
  });

  it("diffs a merge commit against its first parent", async () => {
    commitFiles({ "base.ts": "base" }, "base commit");
    const defaultBranch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    git(repoPath, ["checkout", "-q", "-b", "feature"]);
    commitFiles({ "feature.ts": "feature" }, "feature commit");
    git(repoPath, ["checkout", "-q", defaultBranch]);
    git(repoPath, ["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);
    const mergeSha = git(repoPath, ["rev-parse", "HEAD"]).trim();
    const product = makeCommitProduct({
      metadata: { repo: "testrepo", sha: mergeSha, files: ["feature.ts"] },
    });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).resolves.toBeUndefined();
  });

  it("skips verification when there are no commit work products", async () => {
    const nonCommit = makeCommitProduct({ type: "pull_request", metadata: {} });
    await expect(assertShippedGate({ workProducts: [nonCommit] })).resolves.toBeUndefined();
  });

  it("throws HttpError instances with a 422 status on failure", async () => {
    const product = makeCommitProduct({ metadata: { repo: "unknown-repo", sha: "deadbeef" } });
    await expect(assertShippedGate({ workProducts: [product], resolveRepoLocalPath: resolveToRepo() })).rejects.toMatchObject({
      status: 422,
    });
  });
});
