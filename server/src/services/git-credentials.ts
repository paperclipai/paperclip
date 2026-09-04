import type { Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";

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
 * GitLab additionally supports a self-managed instance at an operator-chosen domain (there is
 * no equivalent for GitHub — GHES stays out of scope, as it always has been here): set
 * `PAPERCLIP_GITLAB_HOSTS` to that instance's `host[:port]` (comma-separated for more than one;
 * include the port explicitly if the instance runs on a non-default one, e.g.
 * `gitlab.mycompany.com:1234` — omitting it only matches the default HTTPS port) and the same
 * `GITLAB_TOKEN`/`PAPERCLIP_GITLAB_TOKEN` company secret or `GITLAB_TOKEN` server env used for
 * gitlab.com now also authenticates that host, with the credential helper scoped strictly to
 * it — never to gitlab.com or a different configured self-managed host.
 *
 * A self-managed instance on a private/internal CA (common — that is usually the whole reason
 * it is self-managed) can additionally set `PAPERCLIP_GITLAB_CA_CERT_PATH` to a PEM bundle file
 * on the server's own filesystem. It is applied only to a self-hosted match, never to
 * gitlab.com: `GIT_SSL_CAINFO` *replaces* git's default trust store for the git process it is
 * set on rather than adding to it, so applying it unconditionally would break TLS verification
 * for the public SaaS domain unless that bundle happened to also carry the public roots.
 */

export type GitProviderId = "github" | "gitlab";

type GitHostProviderConfig = {
  id: GitProviderId;
  /** Human-readable name used in auth-failure guidance, e.g. "GitHub". */
  label: string;
  /** Well-known SaaS hosts this provider answers for. `www.` variants included where served. */
  hosts: readonly string[];
  /** The HTTPS Basic username paired with the token — provider-specific by convention. */
  tokenUsername: string;
  /** Company-secret names probed for this provider's token, in priority order. */
  secretNames: readonly string[];
  /** Server-process env var names probed as a fallback, in priority order. */
  envNames: readonly string[];
  /**
   * Server env var naming this provider's self-managed instance host(s), for operators who
   * run their own server on a custom domain (GitLab's self-hosted offering; there is no
   * equivalent GHES support here, matching this module's prior GHES-out-of-scope stance).
   * Comma-separated; each entry is a bare `host[:port]` or a full URL (only `host[:port]` is
   * used — an explicit non-default port must be included, since it is not inferred).
   * Undefined for a provider with no self-hosted mode.
   */
  selfHostedEnvName?: string;
  /**
   * Server env var naming a PEM CA bundle file trusted for this provider's self-managed
   * instance(s) — for a private/internal CA the public trust store does not include. Applied
   * only when the matched remote is self-hosted (never for the provider's SaaS domain — see
   * the module doc comment for why). Undefined for a provider with no self-hosted mode.
   */
  selfHostedCaCertEnvName?: string;
};

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Company-secret names probed for a GitLab token, in priority order. */
export const DEFAULT_GITLAB_TOKEN_SECRET_NAMES = ["GITLAB_TOKEN", "PAPERCLIP_GITLAB_TOKEN"] as const;

/**
 * Supported git hosts, most specific matching first. `hosts` must stay in sync with
 * `isGitHubDotCom`-style host checks elsewhere in the codebase (`github-fetch.ts`) — GitHub's
 * entry mirrors that list rather than importing it, so this module has no dependency on the
 * GitHub-specific fetch helpers.
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
    // `oauth2` is GitLab's own documented convention for token-based HTTPS auth. It applies
    // the same way to a self-managed instance as it does to gitlab.com.
    tokenUsername: "oauth2",
    secretNames: DEFAULT_GITLAB_TOKEN_SECRET_NAMES,
    envNames: ["GITLAB_TOKEN"],
    selfHostedEnvName: "PAPERCLIP_GITLAB_HOSTS",
    selfHostedCaCertEnvName: "PAPERCLIP_GITLAB_CA_CERT_PATH",
  },
];

function getGitHostProvider(id: GitProviderId): GitHostProviderConfig {
  const provider = GIT_HOST_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown git host provider: ${id}`);
  return provider;
}

/**
 * Extract a lowercase `host[:port]` from an operator-supplied entry in a `selfHostedEnvName`
 * value: either a full URL (`https://gitlab.mycompany.com:1234/`) or a bare
 * `host[:port]` (`gitlab.mycompany.com:1234`). Returns null for an empty or unparseable entry.
 *
 * Deliberately `URL.host`, not `URL.hostname`: git's credential protocol carries the port as
 * part of its `host=` field on a non-default port, and `credential.<url>.helper` config keys
 * are matched port-for-port — a config key that omits the port is consulted only for the
 * scheme's default port (443 for https), never for an arbitrary one. Dropping the port here
 * would silently make a self-hosted instance on a custom port unreachable end-to-end: the
 * helper would never even be consulted, let alone answer.
 */
function normalizeConfiguredHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** This provider's operator-configured self-managed instance hosts, deduplicated. */
function resolveConfiguredSelfHostedHosts(provider: GitHostProviderConfig, env: NodeJS.ProcessEnv): string[] {
  if (!provider.selfHostedEnvName) return [];
  const raw = env[provider.selfHostedEnvName];
  if (!raw) return [];
  const hosts = new Set<string>();
  for (const entry of raw.split(",")) {
    const host = normalizeConfiguredHost(entry);
    if (host) hosts.add(host);
  }
  return Array.from(hosts);
}

/** This provider's operator-configured self-managed CA bundle path, if any. */
function resolveConfiguredCaCertPath(provider: GitHostProviderConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (!provider.selfHostedCaCertEnvName) return undefined;
  return env[provider.selfHostedCaCertEnvName]?.trim() || undefined;
}

/**
 * Resolve the supported provider for one remote URL, or null when the URL is out of scope:
 * non-HTTPS, an unsupported host, or already credentialed (inline userinfo, which this module
 * must never override). Mirrors `isGitHubHttpsRemoteUrl`'s prior scoping rules, generalized
 * across every entry in `GIT_HOST_PROVIDERS`. Static SaaS hosts only — no `env`, so it never
 * depends on ambient process state; self-hosted matching lives in `resolveGitHostMatch` below,
 * which every real credential-resolution path uses instead.
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
 * The full match used by real credential resolution: static SaaS hosts first, then each
 * provider's operator-configured self-hosted hosts (env-driven, see `selfHostedEnvName`).
 * `scopedHosts` is what the credential helper gets installed for — the provider's whole SaaS
 * host list for a SaaS match (unchanged from before self-hosted support existed), or exactly
 * the one matched self-hosted host and no other configured self-hosted host, so one
 * self-managed instance's token is never offered to a different self-managed instance or to
 * the SaaS domain. `selfHosted` tells the caller whether it is safe to also apply a configured
 * CA bundle (see `selfHostedCaCertEnvName`) — never for a SaaS match.
 */
function resolveGitHostMatch(
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
): { provider: GitHostProviderConfig; scopedHosts: readonly string[]; selfHosted: boolean } | null {
  const staticProvider = resolveGitHostProvider(remoteUrl);
  if (staticProvider) return { provider: staticProvider, scopedHosts: staticProvider.hosts, selfHosted: false };

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  // `.host`, not `.hostname` — see `normalizeConfiguredHost` for why the port must survive to
  // this comparison and into `scopedHosts`.
  const hostWithPort = parsed.host.toLowerCase();
  for (const provider of GIT_HOST_PROVIDERS) {
    if (resolveConfiguredSelfHostedHosts(provider, env).includes(hostWithPort)) {
      return { provider, scopedHosts: [hostWithPort], selfHosted: true };
    }
  }
  return null;
}

/**
 * True only for `https://github.com/...` (or `www.`) URLs without inline userinfo. GHES and
 * other hosts are out of scope — sending a github.com token to an arbitrary host would leak
 * it, and an operator's inline URL credential must never be overridden. Static-only: unlike
 * real credential resolution, this helper never consults `PAPERCLIP_GITLAB_HOSTS`-style
 * self-hosted config, so it stays a pure function of its argument.
 */
export function isGitHubHttpsRemoteUrl(remoteUrl: string): boolean {
  return resolveGitHostProvider(remoteUrl)?.id === "github";
}

/**
 * True only for `https://gitlab.com/...` (or `www.`) URLs without inline userinfo. Static-only:
 * a self-managed GitLab instance configured via `PAPERCLIP_GITLAB_HOSTS` is a supported
 * credential target (see `createGitRemoteAuthProvider`) but does not make this function true —
 * this helper is a pure function of its argument, not of ambient server config.
 */
export function isGitLabHttpsRemoteUrl(remoteUrl: string): boolean {
  return resolveGitHostProvider(remoteUrl)?.id === "gitlab";
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
// A bracketed IPv6 host (from `normalizeConfiguredHost`, e.g. `[2001:db8::1]:8443`) would
// otherwise land in the `case` pattern below unescaped, where `[`/`]` are glob character-class
// metacharacters rather than literal brackets — the pattern would then fail to match the
// literal host git requests, and the helper would never authenticate that self-hosted instance.
function escapeCasePattern(value: string): string {
  return value.replace(/[\\*?[\]]/g, "\\$&");
}

function buildCredentialHelperScript(tokenUsername: string, hosts: readonly string[]): string {
  const hostMatch = hosts.map((host) => `host=${escapeCasePattern(host)}`).join("|");
  return (
    `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in ` +
    `${hostMatch}) ok=1;; protocol=https) proto=1;; esac; done; ` +
    `if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=${tokenUsername}\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`
  );
}

export type GitCredential = {
  token: string;
  source: "company_secret" | "server_env";
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
  /** Which host provider this token authenticates against. */
  providerId: GitProviderId;
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
 * host, ssh, or already credentialed) or when no token is available — callers then run git
 * with ambient behavior, exactly as before this module existed.
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

export function buildGitAuthInvocation(
  credential: GitCredential,
  /**
   * Hosts to install the credential helper for. Defaults to the provider's full SaaS host
   * list (e.g. github.com + www.github.com). Real credential resolution
   * (`createGitRemoteAuthProvider`) passes a narrower list — exactly the one matched
   * self-hosted host — when the remote is a self-managed instance, so that host's token is
   * never offered to a different host, including the provider's own SaaS domain.
   */
  scopedHosts?: readonly string[],
  /**
   * A PEM CA bundle path to trust via `GIT_SSL_CAINFO`, for a self-hosted instance on a
   * private/internal CA. Callers must pass this only alongside a self-hosted `scopedHosts`
   * (never for a SaaS match): `GIT_SSL_CAINFO` replaces git's default trust store for the git
   * process it is set on, so applying it to a gitlab.com clone would break that clone's TLS
   * verification unless the bundle also carried the public roots.
   */
  caCertPath?: string,
): GitAuthInvocation {
  const provider = getGitHostProvider(credential.providerId);
  const hosts = scopedHosts ?? provider.hosts;
  const helperScript = buildCredentialHelperScript(provider.tokenUsername, hosts);
  // The leading empty helper clears ambient helpers (gh, glab, osxkeychain, credential-store)
  // so they neither outrank the resolved token nor receive store/erase callbacks for it. Each
  // subsequent entry installs the token helper URL-scoped to one of the resolved hosts: git
  // consults it only for credential requests whose context matches that host over https, so an
  // `insteadOf`-rewritten remote never reaches it (and the helper itself re-checks the request
  // host — see above).
  const configArgs: string[] = ["-c", "credential.helper="];
  for (const host of hosts) {
    configArgs.push("-c", `credential.https://${host}.helper=${helperScript}`);
  }
  const env: Record<string, string> = {
    [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (caCertPath) {
    env.GIT_SSL_CAINFO = caCertPath;
  }
  return {
    configArgs,
    env,
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
 * though no credential was resolved; it is ignored once `used.providerId` is known. `env`
 * (defaulting to `process.env`) lets that branch also recognize an operator-configured
 * self-hosted GitLab host via `PAPERCLIP_GITLAB_HOSTS`.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null; providerId?: GitProviderId } | null;
  remoteUrl?: string | null;
  env?: NodeJS.ProcessEnv;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  const provider = input.used?.providerId
    ? getGitHostProvider(input.used.providerId)
    : (input.remoteUrl ? resolveGitHostMatch(input.remoteUrl, input.env ?? process.env)?.provider ?? null : null);
  if (input.used) {
    const providerLabel = provider?.label ?? "git";
    const label = input.used.secretName
      ? `the ${input.used.secretName} company-secret ${providerLabel} credential`
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
};

/**
 * Build the credential provider for one run. Resolution order per host: company secret by
 * well-known name (in that provider's declared order), then the server process env for
 * self-hosted operators, then null. Lookups are memoized per resolved provider — a run that
 * touches both a GitHub and a GitLab remote performs at most one secret resolution per host
 * (and writes at most one audit event per host) no matter how many git operations it
 * authenticates.
 */
export function createGitRemoteAuthProvider(
  db: Db,
  companyId: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
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
    const match = resolveGitHostMatch(remoteUrl, env);
    if (!match) return null;
    const { provider, scopedHosts, selfHosted } = match;
    let credentialPromise = credentialPromises.get(provider.id);
    if (!credentialPromise) {
      credentialPromise = resolveCredentialFor(provider);
      credentialPromises.set(provider.id, credentialPromise);
    }
    const credential = await credentialPromise;
    if (!credential) return null;
    // Only ever applied to a self-hosted match -- see buildGitAuthInvocation's caCertPath doc.
    const caCertPath = selfHosted ? resolveConfiguredCaCertPath(provider, env) : undefined;
    return buildGitAuthInvocation(credential, scopedHosts, caCertPath);
  };
}
