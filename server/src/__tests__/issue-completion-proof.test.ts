import { describe, expect, it, vi } from "vitest";
import { validateCompletionProof, type GitHubCompletionVerifier } from "../services/issue-completion-proof.js";

const base = {
  deliveryType: "code" as const,
  pullRequestUrl: "https://github.com/acme/repo/pull/1",
  mergedSha: "a".repeat(40),
  defaultBranch: "main",
  acceptance: { command: "pnpm test", output: "passed" },
  implementer: "dev",
  qaReviewer: "qa",
  cleanupNotApplicable: "no_isolated_workspace" as const,
};
const noWorkspace = { workspace: null };
const verified: GitHubCompletionVerifier = vi.fn(async () => []);

describe("completion proof", () => {
  it("rejects evidence-free completion", async () => expect(validateCompletionProof(undefined, noWorkspace, verified)).resolves.toEqual(["completionProof"]));
  it("rejects missing integration", async () => expect(validateCompletionProof(base, noWorkspace, null)).resolves.toContain("configuredGitHubIntegration"));
  it("turns upstream failures into unverifiable evidence", async () => {
    const failing = vi.fn(async () => { throw new Error("offline"); });
    await expect(validateCompletionProof(base, noWorkspace, failing)).resolves.toContain("githubEvidenceVerifiable");
  });
  it("rejects self-QA", async () => expect(validateCompletionProof({ ...base, qaReviewer: "dev" }, noWorkspace, verified)).resolves.toContain("independentQaReviewer"));
  it("rejects incomplete authoritative cleanup", async () => {
    const context = { workspace: { status: "active", closedAt: null, branchName: "feat", metadata: null } };
    await expect(validateCompletionProof({ ...base, cleanupNotApplicable: undefined }, context, verified)).resolves.toContain("workspaceArchivedAndPruned");
  });
  it("accepts complete server evidence", async () => {
    const context = { workspace: { status: "archived", closedAt: new Date(), branchName: "feat", metadata: { cleanupSucceeded: true, pruneSucceeded: true } } };
    await expect(validateCompletionProof({ ...base, cleanupNotApplicable: undefined }, context, verified)).resolves.toEqual([]);
  });
  it("accepts explicit non-code evidence", async () => expect(validateCompletionProof({ deliveryType: "non_code", acceptance: base.acceptance, implementer: "dev", qaReviewer: "qa" }, noWorkspace, null)).resolves.toEqual([]));
});
