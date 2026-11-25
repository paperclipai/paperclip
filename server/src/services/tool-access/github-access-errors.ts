import type { RequestConfirmationResult } from "@paperclipai/shared";

export const GITHUB_ACCESS_DENIED_ERROR_CODE = "github_access_denied" as const;
export const GITHUB_REPO_OUTSIDE_APP_INSTALLATIONS_ERROR_CODE = "github_repo_outside_app_installations" as const;

export type GitHubAccessErrorCode =
  | typeof GITHUB_ACCESS_DENIED_ERROR_CODE
  | typeof GITHUB_REPO_OUTSIDE_APP_INSTALLATIONS_ERROR_CODE;

export function isGitHubAccessErrorCode(code: unknown): code is GitHubAccessErrorCode {
  return code === GITHUB_ACCESS_DENIED_ERROR_CODE
    || code === GITHUB_REPO_OUTSIDE_APP_INSTALLATIONS_ERROR_CODE;
}

export interface GitHubAccessSnapshot {
  login?: unknown;
  installationOwnerLogins?: unknown;
}

export interface GitHubTarget {
  owner: string;
  repo?: string;
}

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_API_REPO_URL_RE = /\bhttps:\/\/api\.github\.com\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})(?=[/:?\s]|$)/i;
const GITHUB_API_ORG_URL_RE = /\bhttps:\/\/api\.github\.com\/orgs\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?=[/:?\s]|$)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function githubOperation(toolName: string): string {
  return (toolName.split(/[.:/]/).pop() ?? "").trim().toLowerCase().replace(/-/g, "_");
}

function validOwner(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return GITHUB_OWNER_RE.test(trimmed) ? trimmed : null;
}

function validRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return GITHUB_REPO_RE.test(trimmed) ? trimmed : null;
}

function parseFullName(value: unknown): GitHubTarget | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("/");
  if (parts.length !== 2) return null;
  const owner = validOwner(parts[0]);
  const repo = validRepo(parts[1]);
  return owner && repo ? { owner, repo } : null;
}

/** Extract the write target owner (and repository when known) from structured
 * GitHub tool parameters, or as a fallback from a GitHub REST API URL in a 403
 * error message. For `fork_repository`, `owner`/`repo` is the upstream source
 * repo rather than the write destination, so only `organization`/`org` counts. */
export function extractGitHubTarget(
  toolName: string,
  parameters: unknown,
  providerMessage?: unknown,
): GitHubTarget | null {
  const op = githubOperation(toolName);
  const params = asRecord(parameters);
  if (op === "create_repository" || op === "fork_repository") {
    const org = validOwner(params.organization ?? params.org);
    if (org) return { owner: org };
    if (typeof providerMessage === "string") {
      const orgMatch = GITHUB_API_ORG_URL_RE.exec(providerMessage.slice(0, 4000));
      const matchedOrg = validOwner(orgMatch?.[1]);
      if (matchedOrg) return { owner: matchedOrg };
    }
    return null;
  }

  const owner = validOwner(params.owner);
  if (owner) {
    const repo = validRepo(params.repo ?? params.repository_name ?? params.repositoryName);
    return repo ? { owner, repo } : { owner };
  }

  for (const key of ["repository", "repo", "repoFullName", "fullName"] as const) {
    const parsed = parseFullName(params[key]);
    if (parsed) return parsed;
  }

  const org = validOwner(params.organization ?? params.org);
  if (org) return { owner: org };

  if (typeof providerMessage === "string") {
    const snippet = providerMessage.slice(0, 4000);
    const repoMatch = GITHUB_API_REPO_URL_RE.exec(snippet);
    if (repoMatch) {
      const matchedOwner = validOwner(repoMatch[1]);
      const matchedRepo = validRepo(repoMatch[2]);
      if (matchedOwner && matchedRepo) return { owner: matchedOwner, repo: matchedRepo };
    }
    const orgMatch = GITHUB_API_ORG_URL_RE.exec(snippet);
    const matchedOrg = validOwner(orgMatch?.[1]);
    if (matchedOrg) return { owner: matchedOrg };
  }

  return null;
}

function normalizedInstalledOwners(githubGrant: GitHubAccessSnapshot | null | undefined): {
  login: string;
  installedOwners: string[];
  installedOwnerSet: Set<string>;
} | null {
  if (!githubGrant) return null;
  const login = validOwner(githubGrant.login);
  if (!login || !Array.isArray(githubGrant.installationOwnerLogins)) return null;
  const seen = new Set<string>();
  const installedOwners: string[] = [];
  for (const entry of githubGrant.installationOwnerLogins) {
    const owner = validOwner(entry);
    if (!owner) continue;
    const key = owner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    installedOwners.push(owner);
  }
  if (installedOwners.length === 0) return null;
  return { login, installedOwners, installedOwnerSet: seen };
}

/** Check whether a managed GitHub App call targets an account/organization
 * outside the Paperclip GitHub App's installed accounts (and not the user's
 * own personal account). Refreshing access cannot grant write access to
 * third-party orgs where the App is not installed. */
export function findUnreachableManagedGitHubTarget(input: {
  sourceTemplateKey: unknown;
  connectionMethodKey: unknown;
  githubGrant: GitHubAccessSnapshot | null | undefined;
  toolName: string;
  parameters?: unknown;
  providerMessage?: unknown;
}): { owner: string; repo?: string; installedOwners: string[]; message: string } | null {
  if (input.sourceTemplateKey !== "github" || input.connectionMethodKey !== "managed") return null;
  const snapshot = normalizedInstalledOwners(input.githubGrant);
  if (!snapshot) return null;
  const target = extractGitHubTarget(input.toolName, input.parameters, input.providerMessage);
  if (!target) return null;
  const targetOwnerLower = target.owner.toLowerCase();
  if (targetOwnerLower === snapshot.login.toLowerCase() || snapshot.installedOwnerSet.has(targetOwnerLower)) {
    return null;
  }
  return {
    ...target,
    installedOwners: snapshot.installedOwners,
    message: githubOutsideAppInstallationsInstructions(target, snapshot.installedOwners),
  };
}

/** GitHub reports repository permission failures inside successful MCP HTTP
 * responses. Do not infer that every 403 is an access problem (rate limits also
 * use 403), or echo provider response text into the repair instructions. */
export function githubAccessError(
  sourceTemplateKey: unknown,
  message: unknown,
  context?: {
    connectionMethodKey?: unknown;
    githubGrant?: GitHubAccessSnapshot | null;
    toolName?: string;
    parameters?: unknown;
  },
): { errorCode: GitHubAccessErrorCode } | null {
  if (sourceTemplateKey !== "github" || typeof message !== "string" ||
      !/\b403\s+Resource not accessible by (?:integration|personal access token)\b/i.test(message.slice(0, 4000))) return null;
  if (context && findUnreachableManagedGitHubTarget({
    sourceTemplateKey,
    connectionMethodKey: context.connectionMethodKey,
    githubGrant: context.githubGrant,
    toolName: context.toolName ?? "",
    parameters: context.parameters,
    providerMessage: message,
  })) {
    return { errorCode: GITHUB_REPO_OUTSIDE_APP_INSTALLATIONS_ERROR_CODE };
  }
  return { errorCode: GITHUB_ACCESS_DENIED_ERROR_CODE };
}

/** Upgrade already saved tool errors using verified connection identity. Retain
 * the stored error and decision, including both legacy invocation error codes. */
export function projectGitHubActionResult(sourceTemplateKey: unknown, result: RequestConfirmationResult | null | undefined): RequestConfirmationResult | null | undefined {
  const action = result?.toolAction;
  if (!action || action.status !== "failed" ||
      (action.errorCode !== "tool_error" && action.errorCode !== "tool_execution_failed")) return result;
  const failure = githubAccessError(sourceTemplateKey, action.errorMessage);
  return failure ? { ...result, toolAction: { ...action, ...failure } } : result;
}

/** Trusted, server-authored next steps when a managed GitHub App connection
 * targets an organization or repository outside the App's installations.
 * Never echoes raw provider text. */
export function githubOutsideAppInstallationsInstructions(
  target?: GitHubTarget | null,
  installedOwners?: string[],
): string {
  const safeTarget = target && validOwner(target.owner)
    ? (target.repo && validRepo(target.repo) ? `${target.owner}/${target.repo}` : target.owner)
    : null;
  const safeInstalled = (installedOwners ?? []).filter((owner) => validOwner(owner) !== null);
  const targetPhrase = safeTarget ? ` for ${safeTarget}` : "";
  const installedPhrase = safeInstalled.length > 0
    ? ` (currently installed on: ${safeInstalled.join(", ")})`
    : "";
  return `GitHub cannot run this action${targetPhrase} because the Paperclip GitHub App is not installed on that organization or account${installedPhrase}. Do not retry or request approval for the same call on this managed GitHub App connection. Never automatically replay an approved write. Refreshing access cannot grant write permission to repositories outside the Paperclip GitHub App's installations. Explain this to the user and offer the drafted content so they can post directly on GitHub, note that a personal access token (PAT) GitHub connection is required to write to external repositories where the App cannot be installed, or—only if they administer that organization—ask an organization admin to install the Paperclip GitHub App there first.`;
}

/** Trusted, server-authored next steps for the agent after GitHub denied an
 * approved action. Access must be repaired before another attempt. The
 * provider text stays in the untrusted result, never in these instructions. */
export function githubAccessDeniedInstructions(toolName: string, connectionMethodKey: unknown = null): string {
  const operation = (toolName.split(":").pop() ?? "").trim().toLowerCase().replace(/-/g, "_");
  const base = "GitHub denied this action because the Paperclip GitHub connection cannot access the requested account or repository. Do not retry or request approval for the same call until GitHub access is repaired. Never automatically replay an approved write.";
  if (connectionMethodKey === "mcp-key") {
    return `${base} Ask the user to check the personal access token's resource owner, repository selection and required permissions in GitHub. They must update or replace the token on the GitHub connection's Permissions page. Continue after they confirm the access change.`;
  }
  if (connectionMethodKey !== "managed") {
    return `${base} Ask the user to open the GitHub connection's Permissions page and check its connected account, authentication method and requested repository access. Continue after they repair that connection.`;
  }
  if (operation === "create_repository") {
    return `${base} Check the repository owner. Connecting a GitHub user does not by itself grant App access to their personal account. For a personal repository, the Paperclip GitHub App needs access to that personal account. For an organization repository, it needs access to that organization; use the tool's organization argument only for an owner the user requested. Open the GitHub connection's Permissions page, select Add More Repos on GitHub, choose the intended account, then Refresh access. If creation remains unavailable, ask the user to create it at https://github.com/new and grant the App access before continuing.`;
  }
  return `${base} Tell the user which account or repository you need. Ask them to give the Paperclip GitHub App access from the GitHub connection's Permissions page and select Refresh access. Continue after they confirm.`;
}

export function githubAccessErrorInstructions(
  errorCode: GitHubAccessErrorCode,
  toolName: string,
  connectionMethodKey: unknown = null,
  target?: GitHubTarget | null,
  installedOwners?: string[],
): string {
  if (errorCode === GITHUB_REPO_OUTSIDE_APP_INSTALLATIONS_ERROR_CODE) {
    return githubOutsideAppInstallationsInstructions(target, installedOwners);
  }
  return githubAccessDeniedInstructions(toolName, connectionMethodKey);
}
