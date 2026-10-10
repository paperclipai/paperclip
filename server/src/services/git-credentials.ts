import {
  companySecrets,
  heartbeatRuns,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { gitHubApiBase, isGitHubDotCom } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";

/**
 * Server-side git credentials for managed project checkouts and execution-workspace base
 * refreshes. Operators store a GitHub token as a company secret under one of the well-known
 * names below (the same convention the GitHub external-object provider reads); this module
 * resolves it and turns it into a git invocation that authenticates clone/fetch against
 * github.com over HTTPS without ever placing the token in argv, URLs, or on disk.
 *
 * The provider factory is deliberately the single seam for future credential sources (for
 * example a brokered GitHub connection): swap the factory, keep every call site unchanged.
 */

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Env var the credential helper reads the token from; never appears in argv. */
export const GIT_CREDENTIAL_TOKEN_ENV_KEY = "PAPERCLIP_GIT_TOKEN";

// `!`-prefixed helpers run via `sh -c` with the credential action appended as "$1". Only the
// `get` action answers; store/erase drain stdin and exit 0 silently. `x-access-token`
// authenticates classic PATs, fine-grained PATs, and GitHub App installation tokens alike.
//
// The helper re-validates the credential request from its stdin description and answers only
// for `protocol=https` + `host=github.com`/`www.github.com`. The pre-invocation URL check
// runs before git applies configuration like repository-local `url.<base>.insteadOf`
// rewrites, so a rewritten remote could otherwise request the token for an arbitrary host.
// The helper is additionally installed URL-scoped (`credential.https://github.com.helper`)
// so git does not consult it for other hosts in the first place — two independent gates.
const GIT_CREDENTIAL_HELPER =
  `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;

export type GitCredential = {
  token: string;
  source: "managed_connection" | "company_secret" | "server_env";
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
  githubIdentity?: { userId: string; login: string };
  identitySource?: "personal" | "dedicated";
  connectionId?: string;
  grantId?: string;
};

/** A prepared, credential-bearing git invocation: config args plus the env that carries the token. */
export type GitAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source: GitCredential["source"];
  secretName: string | null;
};

/**
 * Resolve auth for one remote URL. Returns null when the URL is out of scope (non-GitHub,
 * ssh, or already credentialed) or when no token is available — callers then run git with
 * ambient behavior, exactly as before this module existed.
 */
export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitAuthInvocation | null>;

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

/** An identity GitHub has confirmed for a specific token. */
export type VerifiedGitHubIdentity = { userId: string; login: string; verifiedAt: number };

/**
 * How long a `/user` answer is trusted. GitHub account ids and logins are immutable, so the
 * only thing that can change is which token is being asked about — and the cache is keyed on
 * the token, not the connection. A short window keeps the per-git-operation cost to one request
 * per token per window while bounding how long an unverified tenant record could ride along.
 */
const GITHUB_IDENTITY_CACHE_TTL_MS = 10 * 60_000;
const githubIdentityCache = new Map<string, VerifiedGitHubIdentity>();

export function resetGitHubIdentityCache(): void {
  githubIdentityCache.clear();
}

/**
 * Ask GitHub who a token is. This is the only source of truth for a commit ident: the stored
 * tenant record says which account the connection *was* established as, which can be stale,
 * hand-edited, or a placeholder, and publishing it as an ident would attribute commits to
 * whoever owns that id. Returns null rather than throwing — an unverified identity is a normal
 * outcome (no network, rate limit, a token GitHub rejects) and the caller's response is to
 * refuse the push, not to fall back to a guess.
 */
export async function resolveVerifiedGitHubIdentity(
  token: string,
  options: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<VerifiedGitHubIdentity | null> {
  if (!token) return null;
  const now = options.now ?? Date.now();
  // Keyed on the token so one connection's cached answer can never be served for another's.
  // A raw token is a bearer secret, so only a non-reversible digest is used as a map key.
  const key = createHash("sha256").update(token).digest("hex");
  const cached = githubIdentityCache.get(key);
  if (cached && now - cached.verifiedAt < GITHUB_IDENTITY_CACHE_TTL_MS) return cached;
  let payload: { id?: unknown; login?: unknown };
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(`${gitHubApiBase("github.com")}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "paperclip-git-credential",
      },
    });
    if (!response.ok) return null;
    payload = await response.json() as { id?: unknown; login?: unknown };
  } catch {
    return null;
  }
  const userId = typeof payload?.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0
    ? String(payload.id)
    : typeof payload?.id === "string" && /^[1-9][0-9]{0,19}$/.test(payload.id) ? payload.id : null;
  const login = typeof payload?.login === "string" ? payload.login.trim() : null;
  // Run the answer through the same gate the ident builder uses, so a `/user` payload that is
  // structurally unusable is rejected here rather than producing a malformed ident later.
  if (!userId || !login || !verifiedNoreplyEmail({ userId, login })) return null;
  const identity: VerifiedGitHubIdentity = { userId, login, verifiedAt: now };
  for (const [cachedKey, entry] of githubIdentityCache) {
    if (now - entry.verifiedAt >= GITHUB_IDENTITY_CACHE_TTL_MS) githubIdentityCache.delete(cachedKey);
  }
  githubIdentityCache.set(key, identity);
  return identity;
}

/**
 * Reconcile a stored tenant identity against what the token actually is.
 *
 * Returns the identity to publish, or an error string explaining why none may be published.
 * The stored record is treated as a *claim*, not as authority: a claim that GitHub contradicts
 * is worse than no claim, because it would put commits in another account's name. A token with
 * no resolvable identity fails closed — the caller surfaces the error instead of pushing under
 * a fabricated address.
 */
export function reconcileGitHubIdentity(input: {
  claimed?: { userId?: string | null; login?: string | null } | null;
  verified: VerifiedGitHubIdentity | null;
}): { identity?: { userId: string; login: string }; error?: string } {
  if (!input.verified) {
    return { error: "The GitHub credential could not be verified against GitHub, so no commit identity can be established" };
  }
  const claimedId = input.claimed?.userId?.trim() || null;
  const claimedLogin = input.claimed?.login?.trim() || null;
  if (claimedId && claimedId !== input.verified.userId) {
    // Named in the error because the operator has to go fix a connection record, and the two
    // ids are the whole diagnosis. No token material appears here.
    return {
      error: `The managed GitHub identity is recorded as account ${claimedId} but the credential authenticates as ${input.verified.userId} (${input.verified.login}); refusing to commit under a mismatched identity`,
    };
  }
  if (claimedLogin && claimedLogin.toLowerCase() !== input.verified.login.toLowerCase()) {
    return {
      error: `The managed GitHub identity is recorded as "${claimedLogin}" but the credential authenticates as "${input.verified.login}"; refusing to commit under a mismatched identity`,
    };
  }
  return { identity: { userId: input.verified.userId, login: input.verified.login } };
}

/**
 * Build GitHub's stable noreply address for an account, or null when the identity is not one
 * this module is willing to publish.
 *
 * GitHub resolves the *numeric* half of `<id>+<login>@users.noreply.github.com` and ignores the
 * login entirely, so the id is the part that decides whose name a commit carries. An id that
 * was typed by a human — copied from a sample, seeded into a tenant record, or assumed to be a
 * namespace — silently attributes work to whichever account happens to own it. Only an id and
 * login that GitHub itself answered with may reach an ident; anything else yields no ident at
 * all, so the caller fails or falls back to ambient identity rather than forging one.
 *
 * The login is validated too: it appears verbatim in `user.name` and in the address, so a
 * value that is not a syntactically valid GitHub login (spaces, `@`, newlines, an invented
 * placeholder) is rejected instead of being written into git config.
 */
export function verifiedNoreplyEmail(identity: GitCredential["githubIdentity"]): string | null {
  if (!identity) return null;
  const userId = identity.userId?.trim();
  const login = identity.login?.trim();
  if (!userId || !login) return null;
  // GitHub account ids are positive integers. Reject anything else outright: a non-numeric id
  // is either a mistake or a placeholder, and neither may be published as an ident.
  if (!/^[1-9][0-9]{0,19}$/.test(userId)) return null;
  // GitHub logins are 1–39 chars of alphanumerics and single hyphens, never leading/trailing
  // hyphen, never consecutive hyphens.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) return null;
  return `${userId}+${login}@users.noreply.github.com`;
}

export function buildGitAuthInvocation(credential: GitCredential): GitAuthInvocation {
  const identity = credential.githubIdentity;
  const noreplyEmail = verifiedNoreplyEmail(identity);
  const configEntries = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", GIT_CREDENTIAL_HELPER],
    ["credential.https://www.github.com.helper", GIT_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["url.https://github.com/.insteadOf", "git@www.github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@www.github.com/"],
    // The ident is published only as a pair. Emitting `user.name` with a withheld email would
    // leave git free to pair the fabricated name with whatever address the host happens to
    // have, which is the same misattribution by a different route.
    ...(identity && noreplyEmail ? [
      ["user.name", identity.login],
      ["user.email", noreplyEmail],
    ] : []),
  ];
  return {
    // The leading empty helper clears ambient helpers (gh, osxkeychain, credential-store) so
    // they neither outrank the resolved token nor receive store/erase callbacks for it. The
    // token helper is installed URL-scoped: git consults it only for credential requests
    // whose context matches github.com over https, so an `insteadOf`-rewritten remote never
    // reaches it (and the helper itself re-checks the request host — see above).
    configArgs: [
      "-c", "credential.helper=",
      "-c", `credential.https://github.com.helper=${GIT_CREDENTIAL_HELPER}`,
      "-c", `credential.https://www.github.com.helper=${GIT_CREDENTIAL_HELPER}`,
    ],
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
      GH_TOKEN: credential.token,
      GITHUB_TOKEN: credential.token,
      GIT_TERMINAL_PROMPT: "0",
      ...(identity && noreplyEmail ? {
        GIT_AUTHOR_NAME: identity.login,
        GIT_AUTHOR_EMAIL: noreplyEmail,
        GIT_COMMITTER_NAME: identity.login,
        GIT_COMMITTER_EMAIL: noreplyEmail,
      } : {}),
      GIT_CONFIG_COUNT: String(configEntries.length),
      ...Object.fromEntries(configEntries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ])),
    },
    source: credential.source,
    secretName: credential.secretName,
  };
}

const GIT_AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled|repository not found|not accessible|permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i;

/**
 * Turn a failed git network operation into an actionable suffix for the error message.
 * Returns null when the failure does not look auth-related — a credential that was merely
 * present during an unrelated failure (network outage, target-path collision) must not be
 * blamed for it.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null } | null;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  if (input.used) {
    const label = input.used.secretName
      ? `the ${input.used.secretName} company-secret GitHub credential`
      : input.used.source === "managed_connection"
        ? "the resolved GitHub connection"
      : "the server-environment GitHub credential";
    return `The operation authenticated with ${label}, which was rejected or lacks access to this repository.`;
  }
  return "No GitHub credential is configured — add a GITHUB_TOKEN or GH_TOKEN company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.";
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
 * Build the credential provider for one run. Resolution order: the managed GitHub identity
 * resolver, then a company secret by well-known name, then the server process environment
 * (`GITHUB_TOKEN`/`GH_TOKEN`) for self-hosted operators. A configured managed identity fails
 * closed instead of falling through to legacy credentials. The lookup is memoized per
 * provider instance so one run performs at most one secret resolution (and writes at most
 * one audit event) no matter how many git operations it authenticates.
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
    secretNames?: readonly string[];
  },
): GitRemoteAuthProvider {
  const secrets: GitCredentialSecretsDeps = deps?.secrets ?? secretService(db);
  const env = deps?.env ?? process.env;
  const secretNames = deps?.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  let credentialPromise: Promise<GitCredential | null> | null = null;

  const resolveCredential = async (): Promise<GitCredential | null> => {
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
      if (token) return { token, source: "company_secret", secretName };
    }
    const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
    if (envToken) return { token: envToken, source: "server_env", secretName: null };
    return null;
  };

  return async (remoteUrl: string) => {
    if (!isSupportedGitHubRemoteUrl(remoteUrl)) return null;
    if (db && context?.heartbeatRunId && context.agentId) {
      const [run] = await db.select({ contextId: heartbeatRuns.activeIdentityContextId }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, context.agentId),
      ));
      if (run?.contextId) {
        const { resolveGitHubOperationCredentials } = await import("./github-operation-credentials.js");
        const result = await resolveGitHubOperationCredentials(db, {
          companyId, runId: context.heartbeatRunId, agentId: context.agentId,
        });
        if (result.status === "absent") {
          const credential = await resolveCredential();
          return credential ? buildGitAuthInvocation(credential) : null;
        }
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        return { ...anonymous, env: {
          ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "",
          ...result.env,
        } };
      }
    }
    credentialPromise ??= resolveCredential();
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
    allowStandingDelegation?: boolean;
    excludeGrantId?: string;
  },
): Promise<{
  configured: boolean;
  identitySource?: "personal" | "dedicated";
  grant?: typeof connectionGrants.$inferSelect;
  error?: string;
}> {
  const connections = await db.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId),
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
      (install.targetType === "company" && install.targetId === companyId)
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
  const delegated = context.allowStandingDelegation !== false && !context.responsibleUserId && context.agentId
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
  const identitySource = dedicated.length > 0 ? "dedicated" as const : "personal" as const;
  // Reconnecting can create another connection/grant for the same GitHub
  // account. Ambiguity is about provider identities, not the number of rows.
  // Only trust GitHub's stable account ID; equal logins or missing metadata
  // cannot establish that two grants belong to the same person.
  const githubUserIds = candidates.map((candidate) => candidate.providerTenant?.github?.userId?.trim());
  if (candidates.length === 0 || (candidates.length > 1 && (
    githubUserIds.some((id) => !id) || new Set(githubUserIds).size !== 1
  ))) {
    return {
      configured: true, identitySource,
      error: candidates.length === 0
        ? "No managed GitHub identity is available for this run"
        : "More than one managed GitHub identity matches this run",
    };
  }
  const credentialIds = candidates.flatMap((grant) => grant.credentialSecretRefs
    .filter((ref) => ref.configPath === "oauth.access_token").map((ref) => ref.secretId));
  const credentialRecords = candidates.length > 1 && credentialIds.length > 0
    ? await db.select({
        id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt,
        scope: companySecrets.scope, ownerUserId: companySecrets.ownerUserId,
        definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt,
      }).from(companySecrets).leftJoin(userSecretDefinitions, and(
        eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId),
        eq(userSecretDefinitions.companyId, companyId),
      )).where(and(
        eq(companySecrets.companyId, companyId), inArray(companySecrets.id, credentialIds),
      ))
    : [];
  const hasCredentialRecord = (grant: typeof connectionGrants.$inferSelect) => {
    if (candidates.length === 1) return true;
    const github = grant.providerTenant?.github;
    const ref = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
    return Boolean(github && github.installationCount > 0 && github.repositoryCount > 0 && ref
      && credentialRecords.some((secret) => secret.id === ref.secretId
        && secret.status === "active" && !secret.deletedAt
        && (grant.kind === "user"
          ? secret.scope === "user" && secret.ownerUserId === grant.subjectUserId
            && secret.definitionStatus === "active" && !secret.definitionDeletedAt
          : secret.scope === "company")));
  };
  const isAvailable = (grant: typeof connectionGrants.$inferSelect) =>
    grant.status === "active" && hasCredentialRecord(grant) && githubConnections.some((connection) =>
      connection.id === grant.connectionId && connection.enabled && connection.status === "active",
    );
  // Prefer an available, healthy authorization for this account, then the newest
  // connection grant. Do not rank by updatedAt: refreshes/webhooks change it.
  // Select one grant, preserving its credential and connection policy intact.
  const healthRank = (candidate: typeof connectionGrants.$inferSelect) => {
    const health = githubConnections.find((connection) => connection.id === candidate.connectionId)?.healthStatus;
    return health === "ok" || health === "healthy" ? 2 : health === "unknown" ? 1 : 0;
  };
  const grant = candidates.filter((candidate) => candidate.id !== context.excludeGrantId).sort((a, b) =>
    Number(isAvailable(b)) - Number(isAvailable(a))
    || healthRank(b) - healthRank(a)
    || b.createdAt.getTime() - a.createdAt.getTime()
    || a.id.localeCompare(b.id),
  )[0]!;
  if (!grant) return { configured: true, identitySource, error: "No alternative managed GitHub authorization is available" };
  const connection = githubConnections.find((candidate) => candidate.id === grant.connectionId);
  if (!connection?.enabled || connection.status !== "active") {
    return { configured: true, identitySource, error: "The managed GitHub connection is unavailable" };
  }
  if (grant.status !== "active") return { configured: true, identitySource, error: "The managed GitHub identity must be reconnected" };
  return { configured: true, identitySource, grant };
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

export async function resolveManagedGitHubCredential(
  db: Db,
  secrets: GitCredentialSecretsDeps,
  companyId: string,
  context: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
    allowStandingDelegation?: boolean;
  },
): Promise<{ configured: boolean; identitySource?: "personal" | "dedicated"; credential?: GitCredential; error?: string }> {
  const selection = await resolveManagedGitHubIdentitySelection(db, companyId, context);
  if (!selection.configured) return { configured: false };
  if (!selection.grant) return { configured: true, identitySource: selection.identitySource, error: selection.error };
  const acquire = async (selection: Awaited<ReturnType<typeof resolveManagedGitHubIdentitySelection>>) => {
    let grant = selection.grant!;
    if (grant.kind === "user" && grant.subjectUserId) {
      const [membership] = await db.select({ id: companyMemberships.id, role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, grant.subjectUserId),
        eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership || membership.role === "viewer") return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity owner is not an authorized company member" };
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
    if (!accessRef || !github) return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity is incomplete" };
    if (github.installationCount < 1 || github.repositoryCount < 1) {
      return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity no longer has repository access" };
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
        return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential cannot be resolved" };
      }
      const [secret] = await db.select({
        userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      }).from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.id, accessRef.secretId),
        eq(companySecrets.ownerUserId, grant.subjectUserId),
      )).limit(1);
      if (!secret?.userSecretDefinitionId) return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential is invalid" };
      const resolved = await secrets.resolveUserSecretValue(companyId, {
        definitionId: secret.userSecretDefinitionId,
        responsibleUserId: grant.subjectUserId,
        version: accessRef.versionSelector ?? "latest",
        required: true,
      }, accessContext);
      if (!resolved) return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential is missing" };
      token = resolved.value;
    } else {
      token = await secrets.resolveSecretValue(companyId, accessRef.secretId, accessRef.versionSelector ?? "latest", { accessContext });
    }
    // The tenant record is a claim about which account the connection was established as; the
    // commit ident is published only from what GitHub says the token *is*. A record that
    // contradicts the token — a stale rename, a hand-edited row, a seeded placeholder such as
    // the stand-in `100000001` — would otherwise put every agent commit in an unrelated
    // account's name, so a mismatch fails the whole acquisition instead of degrading silently.
    const reconciliation = reconcileGitHubIdentity({
      claimed: { userId: github.userId, login: github.login },
      verified: await resolveVerifiedGitHubIdentity(token),
    });
    if (!reconciliation.identity) {
      return { configured: true, identitySource: selection.identitySource, error: reconciliation.error };
    }
    return {
      configured: true, identitySource: selection.identitySource,
      credential: {
        token,
        source: "managed_connection" as const,
        secretName: null,
        githubIdentity: reconciliation.identity,
        identitySource: grant.kind === "agent" ? "dedicated" as const : "personal" as const,
        connectionId: grant.connectionId,
        grantId: grant.id,
      },
    };
  };
  let failure: { configured: boolean; identitySource?: "personal" | "dedicated"; error?: string };
  try {
    const result = await acquire(selection);
    if (result.credential) return result;
    failure = result;
  } catch {
    failure = { configured: true, identitySource: selection.identitySource, error: "GitHub credentials are temporarily unavailable" };
  }
  // Retry credential acquisition, never the GitHub operation. An alternate
  // authorization must still belong to this exact principal and account.
  const alternate = await resolveManagedGitHubIdentitySelection(db, companyId, {
    ...context, excludeGrantId: selection.grant.id,
  });
  const accountId = selection.grant.providerTenant?.github?.userId;
  if (!accountId || !alternate.grant || alternate.identitySource !== selection.identitySource
    || alternate.grant.providerTenant?.github?.userId !== accountId
    || alternate.grant.subjectUserId !== selection.grant.subjectUserId
    || alternate.grant.subjectAgentId !== selection.grant.subjectAgentId) return failure;
  try { return await acquire(alternate); } catch { return failure; }
}
