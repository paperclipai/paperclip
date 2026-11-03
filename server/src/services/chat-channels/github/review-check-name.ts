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
  status?: string;
  external_id?: string;
  app?: { id?: number };
};

export async function findGitHubReviewCheck<Check extends GitHubCheckRunSummary>(
  request: (path: string) => Promise<{ check_runs: Check[] }>,
  input: { headSha: string; externalId: string; appId: string | null; name: string },
): Promise<Check | undefined> {
  const names = input.name === LEGACY_GITHUB_REVIEW_CHECK_NAME
    ? [input.name]
    : [input.name, LEGACY_GITHUB_REVIEW_CHECK_NAME];
  for (const name of names) {
    const checks = await request(
      `/commits/${input.headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
    );
    const check = checks.check_runs.find(
      (check) => check.external_id === input.externalId && String(check.app?.id) === input.appId,
    );
    if (check) return check;
  }
  return undefined;
}
