import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { parseIdTokenGroups, reconcileMicrosoftUser } from "./microsoft-rbac.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

// better-auth 1.6 made `Auth<O>` invariant in its options type param, so
// `Auth<BetterAuthOptions>` (betterAuth's generic default) no longer accepts
// the `Auth<typeof authConfig>` our factory actually returns. Derive the
// instance type from the factory's own inferred output instead. (Type aliases
// may forward-reference a function declared later in the module.)
type BetterAuthInstance = ReturnType<typeof createBetterAuthInstance>;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]) {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  // Optional Microsoft Entra OIDC. Enabled only when all three env vars
  // are set; otherwise the socialProviders block is omitted so dev/local
  // installs without an Entra registration still work via email+password.
  //
  // The K8s Secret `paperclip-microsoft-oidc` (paperclip namespace) carries
  // these for the cluster deploy — see deploy/helm/paperclip/values.blockcast.yaml.
  // Redirect URI on the Entra app is `${publicUrl}/api/auth/callback/microsoft`,
  // which better-auth wires up automatically when given a socialProviders.microsoft
  // block. The Entra app issues a `groups` claim (configured server-side)
  // that downstream RBAC can consume off `account.providerData.id_token`;
  // claim→role mapping is a follow-up, not this PR.
  const microsoftClientId = process.env.MICROSOFT_CLIENT_ID?.trim() || undefined;
  const microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim() || undefined;
  const microsoftTenantId = process.env.MICROSOFT_TENANT_ID?.trim() || undefined;
  const microsoftOidcEnabled = Boolean(microsoftClientId && microsoftClientSecret && microsoftTenantId);

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    ...(microsoftOidcEnabled
      ? {
          socialProviders: {
            microsoft: {
              clientId: microsoftClientId!,
              clientSecret: microsoftClientSecret!,
              tenantId: microsoftTenantId!,
            },
          },
          // BLO-6295 piece D: reconcile Entra group claim → paperclip RBAC.
          // The account.create.after hook fires once when the Microsoft
          // identity is first linked; account.update.after fires on every
          // subsequent signin (better-auth updates the access/id token).
          // Both call the same reconcile function — it's idempotent and
          // ssh-users → operator membership / AdminAgents → pending approval
          // both no-op when the state already matches. Failures are logged
          // and swallowed: a Graph hiccup must not block the user signing
          // in (the daily reconciler will catch up).
          databaseHooks: {
            account: {
              create: {
                after: async (account: { providerId?: string; userId?: string; idToken?: string | null }) => {
                  if (account?.providerId !== "microsoft") return;
                  if (!account.userId) return;
                  try {
                    const groups = parseIdTokenGroups(account.idToken ?? null);
                    if (groups.length === 0) return;
                    await reconcileMicrosoftUser(db, account.userId, groups);
                  } catch (err) {
                    console.error("[better-auth] microsoft rbac reconcile (create) failed:", err);
                  }
                },
              },
              update: {
                after: async (account: { providerId?: string; userId?: string; idToken?: string | null }) => {
                  if (account?.providerId !== "microsoft") return;
                  if (!account.userId) return;
                  try {
                    const groups = parseIdTokenGroups(account.idToken ?? null);
                    if (groups.length === 0) return;
                    await reconcileMicrosoftUser(db, account.userId, groups);
                  } catch (err) {
                    console.error("[better-auth] microsoft rbac reconcile (update) failed:", err);
                  }
                },
              },
            },
          },
        }
      : {}),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
