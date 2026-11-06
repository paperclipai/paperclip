export interface GitHubLink {
  kind: "github" | "repository" | "pull_request" | "issue";
  label: string | null;
  description: string;
}

const RESERVED_PATHS = new Set([
  "about", "account", "apps", "business", "codespaces", "collections", "contact",
  "customer-stories", "education", "enterprise", "enterprises", "events", "explore", "features",
  "issues", "join", "login", "logout", "marketplace", "new", "notifications",
  "organizations", "orgs", "pricing", "pulls", "readme", "search", "security",
  "sessions", "settings", "site", "sponsors", "stars", "team", "topics", "trending", "users",
]);

export function parseGitHubLink(href: string | null | undefined): GitHubLink | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || (url.hostname !== "github.com" && url.hostname !== "www.github.com")
    || url.username || url.password || url.port
  ) return null;

  const fallback: GitHubLink = { kind: "github", label: null, description: "GitHub" };
  const segments = url.pathname.replace(/\/$/, "").slice(1).split("/");
  const [owner, repository, type, number] = segments;
  if (
    !owner || !repository || RESERVED_PATHS.has(owner.toLowerCase())
    || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)
    || !/^[a-z\d_.-]+$/i.test(repository)
    || repository === "." || repository === ".."
  ) return fallback;

  const repo = `${owner}/${repository}`;
  if ((type === "pull" || type === "issues") && number && /^[1-9]\d*$/.test(number)) {
    const label = `${repo}#${number}`;
    return {
      kind: type === "pull" ? "pull_request" : "issue",
      label,
      description: `GitHub ${type === "pull" ? "pull request" : "issue"}: ${label}`,
    };
  }
  if (segments.length === 2) {
    return { kind: "repository", label: repo, description: `GitHub repository: ${repo}` };
  }
  return fallback;
}
