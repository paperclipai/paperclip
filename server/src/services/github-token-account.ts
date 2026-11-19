import { and, eq, sql } from "drizzle-orm";
import { companySecrets, connectionGrants, type Db } from "@paperclipai/db";

export type GitHubTokenAccount = {
  userId: string;
  login: string;
  avatarUrl?: string;
  verifiedAt: string;
};

/** The exact token an account was read with: its secret and that secret's version. */
export type GitHubTokenBinding = { secretId: string; secretVersion: number };

type StoredGitHubAccount = NonNullable<
  NonNullable<typeof connectionGrants.$inferSelect["providerTenant"]>["githubAccount"]
>;

/**
 * The current version of a token's secret. Read it *before* resolving the token value,
 * so a rotation in between can only make a recorded account look stale (and be read
 * again), never make an old account look current.
 */
export async function currentGitHubTokenBinding(
  db: Pick<Db, "select">,
  companyId: string,
  secretId: string,
): Promise<GitHubTokenBinding | null> {
  const [secret] = await db
    .select({ latestVersion: companySecrets.latestVersion })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)))
    .limit(1);
  return secret ? { secretId, secretVersion: secret.latestVersion } : null;
}

/** Whether a recorded account belongs to exactly this token version. */
export function isGitHubAccountCurrent(
  account: StoredGitHubAccount | undefined,
  binding: GitHubTokenBinding | null,
): account is StoredGitHubAccount {
  return Boolean(
    account
      && binding
      && account.secretId === binding.secretId
      && account.secretVersion === binding.secretVersion,
  );
}

const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
/** Short on purpose: this runs while a run waits for its git credential. */
const GITHUB_ACCOUNT_LOOKUP_TIMEOUT_MS = 8_000;
const GITHUB_ACCOUNT_RESPONSE_LIMIT_BYTES = 64 * 1024;

/**
 * The GitHub account a personal access token authenticates as. A token has no GitHub
 * App installations, so `GET /user` is the only way to learn whose token it is: that
 * identity de-duplicates several connections for one account and authors managed commits.
 * Errors never include the token or the provider's response body.
 */
export async function loadGitHubTokenAccount(
  token: string,
  request: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<GitHubTokenAccount> {
  let response: Response;
  try {
    response = await request("https://api.github.com/user", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_ACCOUNT_LOOKUP_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new Error("GitHub is unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub rejected the token (HTTP ${response.status})`);
  }
  const text = await response.text();
  if (text.length > GITHUB_ACCOUNT_RESPONSE_LIMIT_BYTES) throw new Error("GitHub returned an oversized account");
  let user: { id?: unknown; login?: unknown; avatar_url?: unknown };
  try {
    user = JSON.parse(text);
  } catch {
    throw new Error("GitHub returned an invalid account identity");
  }
  if (
    typeof user?.id !== "number"
    || !Number.isSafeInteger(user.id)
    || user.id < 1
    || typeof user.login !== "string"
    || !GITHUB_LOGIN_PATTERN.test(user.login)
  ) {
    throw new Error("GitHub returned an invalid account identity");
  }
  return {
    userId: String(user.id),
    login: user.login,
    ...(typeof user.avatar_url === "string" && user.avatar_url.startsWith("https://")
      ? { avatarUrl: user.avatar_url }
      : {}),
    verifiedAt: now().toISOString(),
  };
}

/**
 * Store the token's account on its grant, bound to the token version it was read with.
 * The write is atomic and conditional: it applies only while that version is still the
 * secret's current one, so a stale lookup (an older token's lookup finishing after a
 * rotation) is rejected instead of overwriting the newer account. Only `githubAccount` is
 * merged, never a stale copy of the other provider-tenant fields. `null` clears a recorded
 * account (a replaced token may belong to someone else); it is learned again on next use.
 * `updatedAt` is left alone: setup uses it for optimistic concurrency and this is derived.
 * Returns the updated grant, or null when the write was rejected as stale.
 */
export async function recordGitHubTokenAccount(
  db: Pick<Db, "update">,
  grant: Pick<typeof connectionGrants.$inferSelect, "id" | "companyId">,
  account: GitHubTokenAccount | null,
  binding: GitHubTokenBinding | null,
) {
  const sameGrant = and(eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, grant.companyId));
  if (!account || !binding) {
    const [cleared] = await db
      .update(connectionGrants)
      .set({ providerTenant: sql`coalesce(${connectionGrants.providerTenant}, '{}'::jsonb) - 'githubAccount'` })
      .where(sameGrant)
      .returning();
    return cleared ?? null;
  }
  const recorded = JSON.stringify({ ...account, ...binding });
  const [updated] = await db
    .update(connectionGrants)
    .set({
      providerTenant: sql`coalesce(${connectionGrants.providerTenant}, '{}'::jsonb) || jsonb_build_object('githubAccount', ${recorded}::jsonb)`,
    })
    .where(and(
      sameGrant,
      sql`exists (select 1 from ${companySecrets} where ${companySecrets.id} = ${binding.secretId} and ${companySecrets.companyId} = ${grant.companyId} and ${companySecrets.latestVersion} = ${binding.secretVersion})`,
    ))
    .returning();
  return updated ?? null;
}
