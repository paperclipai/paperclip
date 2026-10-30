export type GitHubPullRequestReference = {
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
};

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?=$|[/?#\s).,!;:'"\x60>\]\}])/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const reference = { host: "github.com", owner, repo, number } as const;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (!references.has(key)) references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[], options: { includeShorthand?: boolean } = {}) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!);
    }
    if (options.includeShorthand !== false) {
      GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
      for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
        addPullRequestReference(references, match[2]!, match[3]!, match[4]!);
      }
    }
  }
  return [...references.values()];
}
