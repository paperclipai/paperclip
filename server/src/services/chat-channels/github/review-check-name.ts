export const LEGACY_GITHUB_REVIEW_CHECK_NAME = "Paperclip Review";

export function githubReviewCheckName(endpoint: {
  botDisplayName: string | null;
  botUsername: string | null;
}) {
  const name = (endpoint.botDisplayName?.trim() || endpoint.botUsername?.replace(/\[bot\]$/, "").trim() || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return name || LEGACY_GITHUB_REVIEW_CHECK_NAME;
}

export type GitHubCheckRunSummary = {
  id: number;
  name?: string;
  status?: string;
  external_id?: string;
  app?: { id?: number };
};

export async function findGitHubReviewCheck<Check extends GitHubCheckRunSummary>(
  request: (path: string) => Promise<{ check_runs: Check[] }>,
  input: { headSha: string; externalId: string; appId: string | null; name: string },
): Promise<Check | undefined> {
  const query = new URLSearchParams({ per_page: "100" });
  if (input.appId) query.set("app_id", input.appId);
  const checks = await request(`/commits/${input.headSha}/check-runs?${query}`);
  const ours = checks.check_runs.filter(
    (check) => check.external_id === input.externalId && String(check.app?.id) === input.appId,
  );
  return ours.find((check) => check.name === input.name) ?? ours[0];
}
