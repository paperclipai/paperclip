import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import {
  genericOAuth,
  keycloak,
  auth0,
  okta,
  microsoftEntraId,
} from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { SsoProviderConfig, SsoRoleRequirement } from "@paperclipai/shared";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

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

export function deriveAuthTrustedOrigins(config: Config): string[] {
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
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
    }
  }

  return Array.from(trustedOrigins);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveClaimAtPath(claims: Record<string, unknown>, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function userHasRequiredRole(
  claims: Record<string, unknown>,
  requirement: SsoRoleRequirement,
): boolean {
  const value = resolveClaimAtPath(claims, requirement.claimPath);
  if (Array.isArray(value)) {
    return requirement.roles.some((role: string) => value.includes(role));
  }
  if (typeof value === "string") {
    return requirement.roles.includes(value);
  }
  return false;
}

function mapSsoProviderToOAuthConfig(provider: SsoProviderConfig): GenericOAuthConfig {
  const base = {
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    ...(provider.scopes ? { scopes: provider.scopes } : {}),
  };

  let baseConfig: GenericOAuthConfig;
  switch (provider.type) {
    case "keycloak":
      baseConfig = keycloak({ ...base, issuer: provider.issuer! });
      break;
    case "auth0":
      baseConfig = auth0({
        ...base,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        domain: provider.domain ?? new URL(provider.issuer!).hostname,
      });
      break;
    case "okta":
      baseConfig = okta({ ...base, issuer: provider.issuer! });
      break;
    case "microsoft_entra_id":
      baseConfig = microsoftEntraId({ ...base, tenantId: provider.tenantId! });
      break;
    case "oidc":
      baseConfig = {
        providerId: provider.providerId,
        discoveryUrl: provider.discoveryUrl!,
        ...base,
      };
      break;
  }

  if (!provider.requiredRoles) {
    return baseConfig;
  }

  const requirement = provider.requiredRoles;
  const upstreamGetUserInfo = baseConfig.getUserInfo;

  baseConfig.getUserInfo = async (tokens) => {
    const rawTokens = tokens.raw as Record<string, unknown> | undefined;
    const idToken = (tokens as Record<string, unknown>).idToken as string | undefined
      ?? rawTokens?.id_token as string | undefined;
    const accessToken = (tokens as Record<string, unknown>).accessToken as string | undefined
      ?? rawTokens?.access_token as string | undefined;

    let hasRole = false;

    if (idToken) {
      const claims = decodeJwtPayload(idToken);
      if (claims && userHasRequiredRole(claims, requirement)) {
        hasRole = true;
      }
    }

    if (!hasRole && accessToken) {
      const claims = decodeJwtPayload(accessToken);
      if (claims && userHasRequiredRole(claims, requirement)) {
        hasRole = true;
      }
    }

    if (idToken || accessToken) {
      if (!hasRole) {
        logger.warn(
          {
            providerId: provider.providerId,
            claimPath: requirement.claimPath,
            requiredRoles: requirement.roles,
          },
          "SSO login rejected: user does not have required role",
        );
        return null;
      }
    } else {
      logger.warn(
        { providerId: provider.providerId },
        "SSO role check skipped: no id_token or access_token in response — access denied",
      );
      return null;
    }

    if (upstreamGetUserInfo) {
      return upstreamGetUserInfo(tokens);
    }
    return null;
  };

  return baseConfig;
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins?: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);

  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const oauthConfigs = config.ssoProviders.map(mapSsoProviderToOAuthConfig);
  const plugins = oauthConfigs.length > 0 ? [genericOAuth({ config: oauthConfigs })] : [];

  const authConfig: Record<string, unknown> = {
    baseURL: baseUrl,
    secret,
    trustedOrigins: effectiveTrustedOrigins,
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
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(oauthConfigs.length > 0
      ? {
          accountLinking: {
            enabled: true,
            trustedProviders: config.ssoProviders.map((p) => p.providerId),
          },
        }
      : {}),
    ...(isHttpOnly ? { advanced: { useSecureCookies: false } } : {}),
  };

  if (!baseUrl) {
    delete authConfig.baseURL;
  }

  return betterAuth(authConfig as Parameters<typeof betterAuth>[0]);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export interface BetterAuthManager {
  handler: RequestHandler;
  resolveSession: (req: Request) => Promise<BetterAuthSessionResult | null>;
  resolveSessionFromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  rebuild: (ssoProviders: SsoProviderConfig[]) => void;
}

export function createBetterAuthManager(
  db: Db,
  config: Config,
  trustedOrigins: string[],
): BetterAuthManager {
  let currentAuth = createBetterAuthInstance(db, config, trustedOrigins);
  let currentHandler = toNodeHandler(currentAuth);

  const manager: BetterAuthManager = {
    handler: (req, res, next) => {
      void Promise.resolve(currentHandler(req, res)).catch(next);
    },
    resolveSession: (req) => resolveBetterAuthSession(currentAuth, req),
    resolveSessionFromHeaders: (headers) =>
      resolveBetterAuthSessionFromHeaders(currentAuth, headers),
    rebuild: (ssoProviders) => {
      const updatedConfig = { ...config, ssoProviders };
      currentAuth = createBetterAuthInstance(db, updatedConfig, trustedOrigins);
      currentHandler = toNodeHandler(currentAuth);
      logger.info(
        { providers: ssoProviders.map((p) => p.providerId) },
        "Better Auth instance rebuilt with updated SSO providers",
      );
    },
  };

  return manager;
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
