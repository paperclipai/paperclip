import {
  companySecrets,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { isGitHubDotCom } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";

/**
 * Server-side git credentials for managed project checkouts and execution-workspace base
 * refreshes. Operators store a provider token as a company secret under one of the well-known
 * names below (the same convention the GitHub external-object provider reads for GitHub);
 * this module resolves it and turns it into a git invocation that authenticates clone/fetch
 * against the matching host over HTTPS without ever placing the token in argv, URLs, or on
 * disk.
 *
 * The provider factory is deliberately the single seam for future credential sources (for
 * example a brokered GitHub or GitLab connection): swap the factory, keep every call site
 * unchanged. Adding a new git host means adding one entry to `GIT_HOST_PROVIDERS` below —
 * nothing else in this module or its callers is host-specific.
 *
 * GitHub additionally supports managed connection identities and SSH remotes rewritten to
 * HTTPS via process-scoped `insteadOf` config. GitLab support here is company-secret /
 * server-env tokens for gitlab.com (self-hosted custom domains land in follow-up commits).
 */

export type GitProviderId = "github" | "gitlab";

type GitHostProviderConfig = {
  id: GitProviderId;
  /** Human-readable name used in auth-failure guidance, e.g. "GitHub". */
  label: string;
  /** Hosts this provider answers for. `www.` variants included where the provider serves them. */
  hosts: readonly string[];
  /** The HTTPS Basic username paired with the token — provider-specific by convention. */
  tokenUsername: string;
  /** Company-secret names probed for this provider's token, in priority order. */
  secretNames: readonly string[];
  /** Server-process env var names probed as a fallback, in priority order. */
  envNames: readonly string[];
};

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Company-secret names probed for a GitLab token, in priority order. */
export const DEFAULT_GITLAB_TOKEN_SECRET_NAMES = ["GITLAB_TOKEN", "PAPERCLIP_GITLAB_TOKEN"] as const;

/**
 * Supported git hosts, most specific matching first. GitHub's hosts mirror `isGitHubDotCom`
 * in `github-fetch.ts`; that helper remains the source of truth for GitHub HTTPS/SSH URL
 * checks below, while this table drives credential-helper host scoping and GitLab matching.
 */
const GIT_HOST_PROVIDERS: readonly GitHostProviderConfig[] = [
  {
    id: "github",
    label: "GitHub",
    hosts: ["github.com", "www.github.com"],
    tokenUsername: "x-access-token",
    secretNames: DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
    envNames: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
  {
    id: "gitlab",
    label: "GitLab",
    hosts: ["gitlab.com", "www.gitlab.com"],
    // GitLab's HTTPS PAT/project-access-token convention: any non-empty username works, but
    // `oauth2` is GitLab's own documented convention for token-based HTTPS auth.
    tokenUsername: "oauth2",
    secretNames: DEFAULT_GITLAB_TOKEN_SECRET_NAMES,
    envNames: ["GITLAB_TOKEN"],
  },
];

function getGitHostProvider(id: GitProviderId): GitHostProviderConfig {
  const provider = GIT_HOST_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown git host provider: ${id}`);
  return provider;
}

/**
 * Resolve the supported HTTPS provider for one remote URL, or null when the URL is out of
 * scope: non-HTTPS, an unsupported/self-hosted host, or already credentialed (inline
 * userinfo, which this module must never override). GitHub SSH remotes are handled
 * separately via `isSupportedGitHubRemoteUrl`.
 */
function resolveGitHostProvider(remoteUrl: string): GitHostProviderConfig | null {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase();
  return GIT_HOST_PROVIDERS.find((provider) => provider.hosts.includes(hostname)) ?? null;
}

/**
 * True only for `https://github.com/...` (or `www.`) URLs without inline userinfo. GHES and
 * other hosts are out of scope for now — sending a github.com token to an arbitrary host
 * would leak it, and an operator's inline URL credential must never be overridden.
 */
export function isGitHubHttpsRemoteUrl(remoteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isGitHubDotCom(parsed.hostname);
}

/**
 * True only for `https://gitlab.com/...` (or `www.`) URLs without inline userinfo.
 * Self-managed GitLab instances are out of scope for now, for the same reason GHES is out of
 * scope for GitHub: this module never sends a gitlab.com token to an arbitrary host.
 */
export function isGitLabHttpsRemoteUrl(remoteUrl: string): boolean {
  return resolveGitHostProvider(remoteUrl)?.id === "gitlab";
}

function isSupportedGitHubRemoteUrl(remoteUrl: string): boolean {
  if (isGitHubHttpsRemoteUrl(remoteUrl)) return true;
  if (/^git@(?:www\.)?github\.com:[^\s]+$/i.test(remoteUrl)) return true;
  try {
    const parsed = new URL(remoteUrl);
    return parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password && isGitHubDotCom(parsed.hostname);
  } catch {
    return false;
  }
}

/** Env var the credential helper reads the token from; never appears in argv. */
export const GIT_CREDENTIAL_TOKEN_ENV_KEY = "PAPERCLIP_GIT_TOKEN";

// `!`-prefixed helpers run via `sh -c` with the credential action appended as "$1". Only the
// `get` action answers; store/erase drain stdin and exit 0 silently. The username is fixed per
// provider (`x-access-token` authenticates classic PATs, fine-grained PATs, and GitHub App
// installation tokens alike; `oauth2` is GitLab's HTTPS token-auth convention).
//
// The helper re-validates the credential request from its stdin description and answers only
// for `protocol=https` + one of the provider's own hosts. The pre-invocation URL check runs
// before git applies configuration like repository-local `url.<base>.insteadOf` rewrites, so a
// rewritten remote could otherwise request the token for an arbitrary host. The helper is
// additionally installed URL-scoped per host (`credential.https://<host>.helper`) so git does
// not consult it for other hosts in the first place — two independent gates.
function buildCredentialHelperScript(tokenUsername: string, hosts: readonly string[]): string {
  const hostMatch = hosts.map((host) => `host=${host}`).join("|");
  return (
    `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in ` +
    `${hostMatch}) ok=1;; protocol=https) proto=1;; esac; done; ` +
    `if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=${tokenUsername}\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`
  );
}

export type GitCredential = {
  token: string;
  source: "managed_connection" | "company_secret" | "server_env";
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
  /** Which host provider this token authenticates against. */
  providerId: GitProviderId;
  githubIdentity?: { userId: string; login: string };
};

/** A prepared, credential-bearing git invocation: config args plus the env that carries the token. */
export type GitAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source: GitCredential["source"];
  secretName: string | null;
  providerId: GitProviderId;
  /**
   * Human-readable provider name for auth-failure warnings, e.g. "GitHub" or "GitLab".
   * Structurally mirrors `workspace-runtime.ts`'s decoupled `GitRemoteAuthInvocation` type, so
   * that module can build a provider-neutral warning without importing `GitProviderId`.
   */
  providerLabel: string;
};

/**
 * Resolve auth for one remote URL. Returns null when the URL is out of scope (unsupported
 * host, already credentialed) or when no token is available — callers then run git with
 * ambient behavior, exactly as before this module existed.
 */
export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitAuthInvocation | null>;

/**
 * Mask credential material embedded in URLs so it never reaches warnings, run errors, or
 * persisted payloads: userinfo on any scheme (`https://user:token@host`,
 * `ssh://user:pass@host`) and the entire query string of any URL (`?access_token=…` and
 * every other parameter — masked wholesale rather than by an inevitably incomplete
 * parameter-name list). Scp-style remotes (`git@host:path`) carry no password and are left
 * alone.
 */
export function scrubGitCredentialText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
}

export function buildGitAuthInvocation(credential: GitCredential): GitAuthInvocation {
  const provider = getGitHostProvider(credential.providerId);
  const helperScript = buildCredentialHelperScript(provider.tokenUsername, provider.hosts);
  // The leading empty helper clears ambient helpers (gh, glab, osxkeychain, credential-store)
  // so they neither outrank the resolved token nor receive store/erase callbacks for it. Each
  // subsequent entry installs the token helper URL-scoped to one of this provider's own hosts:
  // git consults it only for credential requests whose context matches that host over https,
  // so an `insteadOf`-rewritten remote never reaches it (and the helper itself re-checks the
  // request host — see above).
  const configArgs: string[] = ["-c", "credential.helper="];
  for (const host of provider.hosts) {
    configArgs.push("-c", `credential.https://${host}.helper=${helperScript}`);
  }

  const identity = credential.githubIdentity;
  const noreplyEmail = identity ? `${identity.userId}+${identity.login}@users.noreply.github.com` : null;

  // GitHub keeps process-scoped GIT_CONFIG_* entries for SSH→HTTPS rewriting and optional
  // managed-identity commit authorship. GitLab uses argv `-c` helpers only (no SSH rewrite).
  const configEntries: Array<[string, string]> = provider.id === "github"
    ? [
        ["credential.helper", ""],
        ...provider.hosts.map((host): [string, string] => [`credential.https://${host}.helper`, helperScript]),
        ["url.https://github.com/.insteadOf", "git@github.com:"],
        ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
        ["url.https://github.com/.insteadOf", "git@www.github.com:"],
        ["url.https://github.com/.insteadOf", "ssh://git@www.github.com/"],
        ...(identity
          ? [
              ["user.name", identity.login] as [string, string],
              ["user.email", noreplyEmail!] as [string, string],
            ]
          : []),
      ]
    : [];

  return {
    configArgs,
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
      ...(provider.id === "github"
        ? {
            GH_TOKEN: credential.token,
            GITHUB_TOKEN: credential.token,
          }
        : {}),
      GIT_TERMINAL_PROMPT: "0",
      ...(identity
        ? {
            GIT_AUTHOR_NAME: identity.login,
            GIT_AUTHOR_EMAIL: noreplyEmail!,
            GIT_COMMITTER_NAME: identity.login,
            GIT_COMMITTER_EMAIL: noreplyEmail!,
          }
        : {}),
      ...(configEntries.length > 0
        ? {
            GIT_CONFIG_COUNT: String(configEntries.length),
            ...Object.fromEntries(
              configEntries.flatMap(([key, value], index) => [
                [`GIT_CONFIG_KEY_${index}`, key],
                [`GIT_CONFIG_VALUE_${index}`, value],
              ]),
            ),
          }
        : {}),
    },
    source: credential.source,
    secretName: credential.secretName,
    providerId: credential.providerId,
    providerLabel: provider.label,
  };
}

const GIT_AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled|repository not found|not accessible|permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i;

/**
 * Turn a failed git network operation into an actionable suffix for the error message.
 * Returns null when the failure does not look auth-related — a credential that was merely
 * present during an unrelated failure (network outage, target-path collision) must not be
 * blamed for it.
 *
 * `remoteUrl` lets the no-credential-used branch name the right provider's guidance even
 * though no credential was resolved; it is ignored once `used.providerId` is known.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null; providerId?: GitProviderId } | null;
  remoteUrl?: string | null;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  const provider = input.used?.providerId
    ? getGitHostProvider(input.used.providerId)
    : (input.remoteUrl ? resolveGitHostProvider(input.remoteUrl) : null);
  if (input.used) {
    const providerLabel = provider?.label ?? "git";
    const label = input.used.secretName
      ? `the ${input.used.secretName} company-secret ${providerLabel} credential`
      : input.used.source === "managed_connection"
        ? "the resolved GitHub connection"
        : `the server-environment ${providerLabel} credential`;
    return `The operation authenticated with ${label}, which was rejected or lacks access to this repository.`;
  }
  if (provider) {
    const names = provider.secretNames.filter((name) => !name.startsWith("PAPERCLIP_")).join(" or ");
    return `No ${provider.label} credential is configured — add a ${names} company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.`;
  }
  return "No git credential is configured — add a GITHUB_TOKEN/GH_TOKEN or GITLAB_TOKEN company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.";
}

type SecretServiceLike = ReturnType<typeof secretService>;

type GitCredentialSecretsDeps = {
  getByName: (
    companyId: string,
    name: string,
  ) => Promise<{ id: string } | null | undefined> | ReturnType<SecretServiceLike["getByName"]>;
  resolveSecretValue: SecretServiceLike["resolveSecretValue"];
  resolveUserSecretValue?: SecretServiceLike["resolveUserSecretValue"];
};

/**
 * Build the credential provider for one run. Resolution order per host:
 * - GitHub: managed GitHub identity (fails closed when configured), then company secret by
 *   well-known name, then server process environment (`GITHUB_TOKEN`/`GH_TOKEN`).
 * - GitLab: company secret by well-known name, then server process environment (`GITLAB_TOKEN`).
 * Lookups are memoized per resolved provider — a run that touches both a GitHub and a GitLab
 * remote performs at most one secret resolution per host (and writes at most one audit event
 * per host) no matter how many git operations it authenticates.
 */
export function createGitRemoteAuthProvider(
  db: Db,
  companyId: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
  },
  deps?: {
    secrets?: GitCredentialSecretsDeps;
    env?: NodeJS.ProcessEnv;
    /** Overrides the probed company-secret names for every provider a run resolves. Test-only. */
    secretNames?: readonly string[];
  },
): GitRemoteAuthProvider {
  const secrets: GitCredentialSecretsDeps = deps?.secrets ?? secretService(db);
  const env = deps?.env ?? process.env;
  const credentialPromises = new Map<GitProviderId, Promise<GitCredential | null>>();

  const resolveCredentialFor = async (provider: GitHostProviderConfig): Promise<GitCredential | null> => {
    if (provider.id === "github") {
      // Unit callers historically pass a null DB through the typed test seam. Production
      // always supplies a real DB and therefore always checks managed identities before
      // considering legacy secrets or process environment credentials.
      const managed = db
        ? await resolveManagedGitHubCredential(db, secrets, companyId, context ?? {})
        : { configured: false as const };
      if (managed.configured) {
        if (!managed.credential) throw new Error(managed.error ?? "Managed GitHub connection is unavailable");
        return managed.credential;
      }
    }

    const secretNames = deps?.secretNames ?? provider.secretNames;
    for (const secretName of secretNames) {
      const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
      if (!secret) continue;
      // A resolution failure (inactive secret, provider outage) records its own failure audit
      // event; fall through to the next source instead of failing the whole git operation here.
      const token = await secrets
        .resolveSecretValue(companyId, secret.id, "latest", {
          accessContext: {
            consumerType: "system",
            consumerId: "workspace-git-credential",
            actorType: "system",
            issueId: context?.issueId ?? null,
            heartbeatRunId: context?.heartbeatRunId ?? null,
            responsibleUserId: context?.responsibleUserId ?? null,
          },
        })
        .then((value) => value.trim())
        .catch(() => "");
      if (token) return { token, source: "company_secret", secretName, providerId: provider.id };
    }
    for (const envName of provider.envNames) {
      const envToken = env[envName]?.trim();
      if (envToken) return { token: envToken, source: "server_env", secretName: null, providerId: provider.id };
    }
    return null;
  };

  return async (remoteUrl: string) => {
    const provider = isSupportedGitHubRemoteUrl(remoteUrl)
      ? getGitHostProvider("github")
      : resolveGitHostProvider(remoteUrl);
    if (!provider) return null;
    let credentialPromise = credentialPromises.get(provider.id);
    if (!credentialPromise) {
      credentialPromise = resolveCredentialFor(provider);
      credentialPromises.set(provider.id, credentialPromise);
    }
    const credential = await credentialPromise;
    if (!credential) return null;
    return buildGitAuthInvocation(credential);
  };
}

export async function resolveManagedGitHubIdentitySelection(
  db: Db,
  companyId: string,
  context: {
    responsibleUserId?: string | null;
    agentId?: string | null;
  },
): Promise<{
  configured: boolean;
  grant?: typeof connectionGrants.$inferSelect;
  error?: string;
}> {
  const connections = await db.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId),
    eq(toolConnections.enabled, true),
    eq(toolConnections.status, "active"),
  ));
  const githubConnections = connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object" ? connection.config as Record<string, unknown> : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return { configured: false };

  const connectionIds = githubConnections.map((connection) => connection.id);
  const installs = await db.select().from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId),
    inArray(toolConnectionInstalls.connectionId, connectionIds),
  ));
  const eligibleConnectionIds = new Set(githubConnections.filter((connection) => installs.some((install) =>
    install.connectionId === connection.id && (
      install.targetType === "company"
      || (install.targetType === "agent" && install.targetId === context.agentId)
    )
  )).map((connection) => connection.id));
  // A GitHub connection installed only for another agent is not configured for
  // this run. Treating the company-wide connection as configured here would
  // make unrelated agents fail before their adapter starts and would also
  // suppress their otherwise-eligible legacy credential fallback.
  if (eligibleConnectionIds.size === 0) return { configured: false };
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId),
    inArray(connectionGrants.connectionId, [...eligibleConnectionIds]),
    or(eq(connectionGrants.kind, "agent"), eq(connectionGrants.kind, "user")),
  ));
  const dedicated = context.agentId
    ? grants.filter((grant) => grant.kind === "agent" && grant.subjectAgentId === context.agentId)
    : [];
  // Connections are already restricted above to the owner-selected install
  // targets. Within that consent boundary the server-resolved responsible user
  // is authoritative; standing delegation is only an ownerless-run fallback.
  const personal = context.responsibleUserId
    ? grants.filter((grant) => grant.kind === "user" && grant.subjectUserId === context.responsibleUserId)
    : [];
  const delegated = !context.responsibleUserId && context.agentId
    ? await db.select({ grantId: connectionGrantDelegations.grantId }).from(connectionGrantDelegations).where(and(
        eq(connectionGrantDelegations.companyId, companyId),
        eq(connectionGrantDelegations.agentId, context.agentId),
        inArray(connectionGrantDelegations.grantId, grants.map((grant) => grant.id)),
      )).then((rows) => {
        const delegatedIds = new Set(rows.map((row) => row.grantId));
        return grants.filter((grant) => grant.kind === "user" && delegatedIds.has(grant.id));
      })
    : [];
  const candidates = dedicated.length > 0 ? dedicated : personal.length > 0 ? personal : delegated;
  if (candidates.length !== 1) {
    return {
      configured: true,
      error: candidates.length === 0
        ? "No managed GitHub identity is available for this run"
        : "More than one managed GitHub identity matches this run",
    };
  }
  const grant = candidates[0]!;
  if (grant.status !== "active") return { configured: true, error: "The managed GitHub identity must be reconnected" };
  return { configured: true, grant };
}

export async function filterResolvedGitHubConnectionsForRun<T extends {
  id: string;
  config?: unknown;
  transportConfig?: unknown;
}>(input: {
  db: Db;
  companyId: string;
  agentId: string;
  responsibleUserId?: string | null;
  connections: T[];
}): Promise<T[]> {
  const githubConnections = input.connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object"
      ? connection.config as Record<string, unknown>
      : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return input.connections;
  const selection = await resolveManagedGitHubIdentitySelection(input.db, input.companyId, {
    agentId: input.agentId,
    responsibleUserId: input.responsibleUserId ?? null,
  });
  const selectedConnectionId = selection.grant?.connectionId ?? null;
  const githubIds = new Set(githubConnections.map((connection) => connection.id));
  return input.connections.filter((connection) =>
    !githubIds.has(connection.id) || connection.id === selectedConnectionId,
  );
}

async function resolveManagedGitHubCredential(
  db: Db,
  secrets: GitCredentialSecretsDeps,
  companyId: string,
  context: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
  },
): Promise<{ configured: boolean; credential?: GitCredential; error?: string }> {
  const selection = await resolveManagedGitHubIdentitySelection(db, companyId, context);
  if (!selection.configured) return { configured: false };
  if (!selection.grant) return { configured: true, error: selection.error };
  let grant = selection.grant;
  if (grant.kind === "user" && grant.subjectUserId) {
    const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, grant.subjectUserId),
      eq(companyMemberships.status, "active"),
    )).limit(1);
    if (!membership) return { configured: true, error: "The managed GitHub identity owner is not an active company member" };
  }
  const expiresAt = grant.providerTenant?.oauth?.accessTokenExpiresAt;
  const refreshedAt = grant.providerTenant?.oauth?.refreshedAt;
  const expiryMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  const refreshedMs = typeof refreshedAt === "string" ? Date.parse(refreshedAt) : Number.NaN;
  if (Number.isFinite(expiryMs) && (
    expiryMs <= Date.now() + 60 * 60_000
    || !Number.isFinite(refreshedMs)
    || refreshedMs <= Date.now() - 30 * 24 * 60 * 60_000
  )) {
    grant = await toolAccessService(db).refreshOAuthGrantCredentials({
      companyId,
      connectionId: grant.connectionId,
      grantId: grant.id,
      actor: { actorType: "system", actorId: "workspace-git-credential" },
      issueId: context.issueId,
      heartbeatRunId: context.heartbeatRunId,
    });
  }
  const accessRef = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
  const github = grant.providerTenant?.github;
  if (!accessRef || !github) return { configured: true, error: "The managed GitHub identity is incomplete" };
  if (github.installationCount < 1 || github.repositoryCount < 1) {
    return { configured: true, error: "The managed GitHub identity no longer has repository access" };
  }
  const accessContext = {
    consumerType: "system" as const,
    consumerId: "workspace-git-credential",
    actorType: "system" as const,
    actorId: context.agentId ?? undefined,
    issueId: context.issueId ?? null,
    heartbeatRunId: context.heartbeatRunId ?? null,
    responsibleUserId: context.responsibleUserId ?? null,
  };
  let token: string;
  if (grant.kind === "user") {
    if (!grant.subjectUserId || !secrets.resolveUserSecretValue) {
      return { configured: true, error: "The personal GitHub credential cannot be resolved" };
    }
    const [secret] = await db.select({
      userSecretDefinitionId: companySecrets.userSecretDefinitionId,
    }).from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.id, accessRef.secretId),
      eq(companySecrets.ownerUserId, grant.subjectUserId),
    )).limit(1);
    if (!secret?.userSecretDefinitionId) return { configured: true, error: "The personal GitHub credential is invalid" };
    const resolved = await secrets.resolveUserSecretValue(companyId, {
      definitionId: secret.userSecretDefinitionId,
      responsibleUserId: grant.subjectUserId,
      version: accessRef.versionSelector ?? "latest",
      required: true,
    }, accessContext);
    if (!resolved) return { configured: true, error: "The personal GitHub credential is missing" };
    token = resolved.value;
  } else {
    token = await secrets.resolveSecretValue(companyId, accessRef.secretId, accessRef.versionSelector ?? "latest", { accessContext });
  }
  return {
    configured: true,
    credential: {
      token,
      source: "managed_connection",
      secretName: null,
      providerId: "github",
      githubIdentity: { userId: github.userId, login: github.login },
    },
  };
}
