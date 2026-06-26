const GITHUB_REPO_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:\/(?:pull|compare|tree|commit)\/[^\s)\]}<>"']*)?/gi;
const SSH_GITHUB_REPO_URL_RE = /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?/gi;
const MERGE_CONFIRMATION_RE = /\b(?:merge|merger|merged|pr|pull request)\b/i;

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return [
    readString(record.prompt),
    readString(record.acceptLabel),
    readString(record.rejectLabel),
    readString(record.detailsMarkdown),
  ].filter(Boolean).join("\n");
}

export function normalizeRepositoryLocator(input: string | null | undefined) {
  const raw = input?.trim();
  if (!raw) return null;

  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(raw);
  if (sshMatch) return `github.com/${sshMatch[1].toLowerCase()}/${sshMatch[2].toLowerCase().replace(/\.git$/i, "")}`;

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== "github.com") return raw.replace(/\.git$/i, "").toLowerCase();
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `github.com/${owner.toLowerCase()}/${repo.toLowerCase().replace(/\.git$/i, "")}`;
  } catch {
    const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i.exec(raw);
    if (match) return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase().replace(/\.git$/i, "")}`;
    return raw.replace(/\.git$/i, "").toLowerCase();
  }
}

export function extractGithubRepositoryLocators(markdown: string) {
  const repos = new Set<string>();
  for (const match of markdown.matchAll(GITHUB_REPO_URL_RE)) {
    repos.add(`github.com/${match[1].toLowerCase()}/${match[2].toLowerCase().replace(/\.git$/i, "")}`);
  }
  for (const match of markdown.matchAll(SSH_GITHUB_REPO_URL_RE)) {
    repos.add(`github.com/${match[1].toLowerCase()}/${match[2].toLowerCase().replace(/\.git$/i, "")}`);
  }
  return [...repos];
}

export function isMergeRequestConfirmationContent(input: {
  title?: string | null;
  summary?: string | null;
  payload: unknown;
}) {
  const text = [
    input.title ?? "",
    input.summary ?? "",
    payloadText(input.payload),
  ].join("\n");
  return MERGE_CONFIRMATION_RE.test(text);
}

export function findMismatchedConfirmationRepositories(input: {
  title?: string | null;
  summary?: string | null;
  payload: unknown;
  expectedRepoUrl?: string | null;
}) {
  const expected = normalizeRepositoryLocator(input.expectedRepoUrl);
  if (!expected) return [];

  const text = [
    input.title ?? "",
    input.summary ?? "",
    payloadText(input.payload),
  ].join("\n");
  if (!MERGE_CONFIRMATION_RE.test(text)) return [];

  return extractGithubRepositoryLocators(text).filter((repo) => repo !== expected);
}
