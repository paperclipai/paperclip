/**
 * Single source of truth for deciding whether an agent-initiated code
 * publication (push, PR/MR, remote change, package release, etc.) targets a
 * repository the current issue/workspace/project is authorized to publish
 * to.
 *
 * Origin: DAN-273 (an agent opened a PR against the upstream
 * `paperclipai/paperclip` repo instead of the authorized fork). The plan in
 * DAN-278 requires exactly one resolver consumed by every checkpoint
 * (git push, `git remote add|set-url`, PR/MR creation via CLI or API, and
 * MCP publish connectors) rather than duplicated per-tool logic.
 */

export interface NormalizedRepo {
  host: string;
  owner: string;
  repo: string;
}

export type RepoAuthorizationDecision = "authorized" | "denied" | "unknown";

/**
 * Normalizes a git/HTTP(S) repository URL or `owner/repo` shorthand into
 * host+owner+repo. Host is lowercased (case-insensitive per the DAN-278
 * plan); owner/repo are compared with exact case since the plan mandates
 * exact-match comparison there. Returns null for unparsable input, which
 * callers must treat as "unknown" -> denied (fail-closed), never as a
 * successful match.
 */
export function normalizeRepoUrl(input: string | null | undefined): NormalizedRepo | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const stripDotGit = (value: string) => value.replace(/\.git\/?$/i, "");

  // scp-like ssh form: git@host:owner/repo(.git)
  const scpMatch = trimmed.match(/^[a-zA-Z0-9_.-]+@([^:/]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1].toLowerCase();
    const rest = stripDotGit(scpMatch[2].replace(/^\/+/, ""));
    const parts = rest.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    return { host, owner, repo };
  }

  // URL forms: ssh://, git://, http(s)://
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    if (!host) return null;
    const rest = stripDotGit(url.pathname.replace(/^\/+/, ""));
    const parts = rest.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    return { host, owner, repo };
  } catch {
    return null;
  }
}

export function normalizedReposEqual(a: NormalizedRepo, b: NormalizedRepo): boolean {
  return a.host === b.host && a.owner === b.owner && a.repo === b.repo;
}

export function formatNormalizedRepo(repo: NormalizedRepo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

export interface AuthorizedRepoSourceInput {
  /** Repo declared on the current issue's execution workspace. Highest priority (DAN-278 section 4.1). */
  issueWorkspaceRepoUrl?: string | null;
  /** Repo declared on the project/workspace config. Used only when no issue-level repo exists (section 4.2). */
  projectRepoUrl?: string | null;
  /** Additional repos explicitly allow-listed for this scope (e.g. upstream promoted to a write destination). */
  additionalAuthorizedRepoUrls?: readonly string[];
}

/**
 * Resolves the authorized destination set per DAN-278 section 4: issue/workspace
 * wins over project; if neither is configured there is NO implicit default
 * (deny-by-default) rather than inferring from whatever remote happens to be
 * configured locally.
 */
export function resolveAuthorizedRepos(input: AuthorizedRepoSourceInput): NormalizedRepo[] {
  const primary = normalizeRepoUrl(input.issueWorkspaceRepoUrl) ?? normalizeRepoUrl(input.projectRepoUrl);
  const results: NormalizedRepo[] = [];
  if (primary) results.push(primary);
  for (const extra of input.additionalAuthorizedRepoUrls ?? []) {
    const normalized = normalizeRepoUrl(extra);
    if (normalized && !results.some((existing) => normalizedReposEqual(existing, normalized))) {
      results.push(normalized);
    }
  }
  return results;
}

/**
 * Classifies a publication destination against the authorized set.
 * Unresolvable candidates return "unknown" (never silently "authorized");
 * callers must fail closed on both "denied" and "unknown".
 */
export function classifyRepoDestination(
  candidateUrl: string | null | undefined,
  authorized: readonly NormalizedRepo[],
): RepoAuthorizationDecision {
  const candidate = normalizeRepoUrl(candidateUrl);
  if (!candidate) return "unknown";
  const isAuthorized = authorized.some((repo) => normalizedReposEqual(repo, candidate));
  return isAuthorized ? "authorized" : "denied";
}

export function isRepoDestinationAuthorized(
  candidateUrl: string | null | undefined,
  authorized: readonly NormalizedRepo[],
): boolean {
  return classifyRepoDestination(candidateUrl, authorized) === "authorized";
}

export interface RepoGuardCheckResult {
  decision: RepoAuthorizationDecision;
  candidate: NormalizedRepo | null;
  authorized: NormalizedRepo[];
  /** Actionable message naming the rejected and expected destination (DAN-278 section 6.6). */
  message: string;
}

export function checkRepoDestination(
  candidateUrl: string | null | undefined,
  authorizedInput: AuthorizedRepoSourceInput,
): RepoGuardCheckResult {
  const authorized = resolveAuthorizedRepos(authorizedInput);
  const candidate = normalizeRepoUrl(candidateUrl);
  const decision = classifyRepoDestination(candidateUrl, authorized);

  if (decision === "authorized") {
    return { decision, candidate, authorized, message: "" };
  }

  const rejectedLabel = candidate ? formatNormalizedRepo(candidate) : String(candidateUrl ?? "(unresolvable destination)");
  const expectedLabel = authorized.length > 0
    ? authorized.map(formatNormalizedRepo).join(", ")
    : "(no authorized repository configured for this issue/workspace/project)";
  const reason = decision === "unknown"
    ? "the destination could not be resolved to a host/owner/repo (fail-closed: unresolvable destinations are treated as denied)"
    : "the destination is not in the authorized repository list for this issue/workspace/project";
  const message =
    `Blocked: publishing to "${rejectedLabel}" is not allowed because ${reason}. ` +
    `Authorized destination(s): ${expectedLabel}. ` +
    `If this is intentional, add the destination to the issue/workspace/project's authorized repository configuration before retrying.`;

  return { decision, candidate, authorized, message };
}
