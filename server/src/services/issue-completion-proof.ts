import type { UpdateIssue } from "@paperclipai/shared";

export type IssueCompletionProof = NonNullable<UpdateIssue["completionProof"]>;
export type CompletionProofContext = {
  workspace: { status: string; closedAt: Date | null; branchName: string | null; metadata: Record<string, unknown> | null } | null;
};
export type GitHubCompletionVerifier = (input: {
  pullRequestUrl: string;
  mergedSha: string;
  defaultBranch: string;
  featureBranch: string | null;
}) => Promise<string[]>;

export function githubCompletionVerifier(token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN): GitHubCompletionVerifier | null {
  if (!token) return null;
  return async ({ pullRequestUrl, mergedSha, defaultBranch, featureBranch }) => {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullRequestUrl);
    if (!match) return ["validPullRequestUrl"];
    const [, owner, repo, number] = match;
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
    const get = async (path: string) => {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, { headers });
      if (!response.ok) throw new Error(`GitHub verification failed: ${response.status}`);
      return response.json() as Promise<any>;
    };
    const missing: string[] = [];
    const [pr, repository] = await Promise.all([get(`/pulls/${number}`), get("")]);
    if (!pr.merged || pr.merge_commit_sha !== mergedSha) missing.push("mergedPullRequestSha");
    if (repository.default_branch !== defaultBranch) missing.push("concreteDefaultBranch");
    const comparison = await get(`/compare/${encodeURIComponent(mergedSha)}...${encodeURIComponent(defaultBranch)}`);
    if (!["ahead", "identical"].includes(comparison.status)) missing.push("shaReachableFromDefaultBranch");
    const checks = await get(`/commits/${mergedSha}/check-runs`);
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs : [];
    if (runs.length === 0 || runs.some((run: any) => run.status !== "completed" || !["success", "neutral", "skipped"].includes(run.conclusion))) missing.push("requiredCiPassedForMergedSha");
    if (featureBranch) {
      const branch = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(featureBranch)}`, { headers });
      if (branch.status !== 404) missing.push("featureBranchDeleted");
    }
    return missing;
  };
}

export async function validateCompletionProof(
  proof: IssueCompletionProof | undefined,
  context: CompletionProofContext,
  verifier: GitHubCompletionVerifier | null,
): Promise<string[]> {
  if (!proof) return ["completionProof"];
  const missing: string[] = [];
  if (proof.implementer === proof.qaReviewer) missing.push("independentQaReviewer");
  if (proof.deliveryType === "non_code") return missing;
  const workspace = context.workspace;
  if (workspace) {
    const cleanupSucceeded = workspace.metadata?.cleanupSucceeded === true && workspace.metadata?.pruneSucceeded === true;
    if (workspace.status !== "archived" || !workspace.closedAt || !cleanupSucceeded) missing.push("workspaceArchivedAndPruned");
    if (proof.cleanupNotApplicable === "no_isolated_workspace") missing.push("validCleanupNotApplicable");
  } else if (proof.cleanupNotApplicable !== "no_isolated_workspace") {
    missing.push("workspaceCleanupEvidence");
  }
  const featureBranch = workspace?.branchName ?? null;
  if (!featureBranch && proof.cleanupNotApplicable !== "no_feature_branch" && workspace) missing.push("featureBranchCleanupEvidence");
  if (featureBranch && proof.cleanupNotApplicable === "no_feature_branch") missing.push("validCleanupNotApplicable");
  if (!verifier) return [...missing, "configuredGitHubIntegration"];
  try {
    missing.push(...await verifier({ ...proof, featureBranch }));
  } catch {
    missing.push("githubEvidenceVerifiable");
  }
  return [...new Set(missing)];
}
