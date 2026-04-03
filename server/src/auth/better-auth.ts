import type { Request as ExpressRequest, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth, generateId } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { Config } from "../config.js";

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
type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type ClerkJwtClaims = {
  sub?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  azp?: string;
  email?: string;
  email_address?: string;
  name?: string;
  full_name?: string;
  given_name?: string;
  family_name?: string;
  username?: string;
};

type ClerkJwtConfig = {
  issuer: string;
  jwksUrl: string;
  authorizedParties: Set<string>;
};

type JwtParts = {
  header: JwtHeader;
  claims: ClerkJwtClaims;
  signingInput: string;
  signature: Uint8Array;
};

type ClerkIdentity = {
  subject: string;
  email: string;
  name: string | null;
};

type ClerkJwksCache = {
  expiresAt: number;
  jwksUrl: string;
  keysByKid: Map<string, JsonWebKey>;
};
type RsaJwk = JsonWebKey & {
  kid?: string;
  kty?: string;
};

const CLERK_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

let clerkJwksCache: ClerkJwksCache | null = null;

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

function headersFromExpressRequest(req: ExpressRequest): Headers {
  return headersFromNodeHeaders(req.headers);
}

function decodeBase64Url(input: string): Uint8Array | null {
  if (!input) return null;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    return Uint8Array.from(Buffer.from(padded, "base64"));
  } catch {
    return null;
  }
}

function decodeBase64UrlJson<T>(input: string): T | null {
  const bytes = decodeBase64Url(input);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function parseCacheControlMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) return null;
  const seconds = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function parseJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const claims = decodeBase64UrlJson<ClerkJwtClaims>(encodedClaims);
  const signature = decodeBase64Url(encodedSignature);
  if (!header || !claims || !signature) return null;

  return {
    header,
    claims,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeAuthorizedParty(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function resolveClerkJwtConfig(): ClerkJwtConfig | null {
  const issuer = process.env.CLERK_ISSUER?.trim();
  const jwksUrl = process.env.CLERK_JWKS_URL?.trim();
  if (!issuer || !jwksUrl) return null;

  const authorizedParties = new Set<string>();
  const publicBaseUrl = normalizeAuthorizedParty(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "");
  if (publicBaseUrl) authorizedParties.add(publicBaseUrl);

  const configuredAuthorizedParties = process.env.CLERK_AUTHORIZED_PARTIES
    ?.split(",")
    .map((value) => normalizeAuthorizedParty(value))
    .filter((value): value is string => Boolean(value));
  for (const value of configuredAuthorizedParties ?? []) {
    authorizedParties.add(value);
  }

  return { issuer, jwksUrl, authorizedParties };
}

function extractClerkIdentity(claims: ClerkJwtClaims): ClerkIdentity | null {
  const subject = claims.sub?.trim();
  const rawEmail = claims.email ?? claims.email_address;
  const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : "";
  if (!subject || !email) return null;

  const directName =
    typeof claims.name === "string" && claims.name.trim().length > 0
      ? claims.name.trim()
      : typeof claims.full_name === "string" && claims.full_name.trim().length > 0
        ? claims.full_name.trim()
        : null;
  const givenName = typeof claims.given_name === "string" ? claims.given_name.trim() : "";
  const familyName = typeof claims.family_name === "string" ? claims.family_name.trim() : "";
  const joinedName = [givenName, familyName].filter((part) => part.length > 0).join(" ").trim();
  const fallbackName =
    joinedName ||
    (typeof claims.username === "string" && claims.username.trim().length > 0 ? claims.username.trim() : null) ||
    email.split("@")[0] ||
    null;

  return {
    subject,
    email,
    name: directName ?? fallbackName,
  };
}

function validateClerkClaims(claims: ClerkJwtClaims, config: ClerkJwtConfig): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer) return false;
  if (typeof claims.exp !== "number" || claims.exp <= now) return false;
  if (typeof claims.nbf === "number" && claims.nbf > now) return false;
  const azp = typeof claims.azp === "string" ? normalizeAuthorizedParty(claims.azp) : null;
  if (azp && config.authorizedParties.size > 0 && !config.authorizedParties.has(azp)) {
    return false;
  }
  return true;
}

async function fetchClerkJwks(jwksUrl: string): Promise<ClerkJwksCache | null> {
  const response = await fetch(jwksUrl, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { keys?: RsaJwk[] } | null;
  const keys = Array.isArray(payload?.keys) ? payload.keys : null;
  if (!keys || keys.length === 0) return null;

  const keysByKid = new Map<string, JsonWebKey>();
  for (const key of keys) {
    if (!key || typeof key !== "object") continue;
    if (key.kty !== "RSA") continue;
    const kid = typeof key.kid === "string" ? key.kid.trim() : "";
    if (!kid) continue;
    keysByKid.set(kid, key);
  }
  if (keysByKid.size === 0) return null;

  const maxAgeMs = parseCacheControlMaxAge(response.headers.get("cache-control")) ?? CLERK_JWKS_CACHE_TTL_MS;
  return {
    jwksUrl,
    expiresAt: Date.now() + maxAgeMs,
    keysByKid,
  };
}

async function getClerkJwk(kid: string, config: ClerkJwtConfig): Promise<JsonWebKey | null> {
  const cached = clerkJwksCache;
  if (
    cached &&
    cached.jwksUrl === config.jwksUrl &&
    cached.expiresAt > Date.now() &&
    cached.keysByKid.has(kid)
  ) {
    return cached.keysByKid.get(kid) ?? null;
  }

  if (!cached || cached.jwksUrl !== config.jwksUrl || cached.expiresAt <= Date.now()) {
    clerkJwksCache = await fetchClerkJwks(config.jwksUrl);
  }

  if (clerkJwksCache?.keysByKid.has(kid)) {
    return clerkJwksCache.keysByKid.get(kid) ?? null;
  }

  // Unknown KID can appear before cache expiry during key rotation.
  clerkJwksCache = await fetchClerkJwks(config.jwksUrl);
  return clerkJwksCache?.keysByKid.get(kid) ?? null;
}

async function verifyClerkJwt(token: string): Promise<ClerkIdentity | null> {
  const config = resolveClerkJwtConfig();
  if (!config) return null;

  const parsed = parseJwt(token);
  if (!parsed) return null;
  if (parsed.header.alg !== "RS256") return null;
  const kid = parsed.header.kid?.trim();
  if (!kid) return null;

  const jwk = await getClerkJwk(kid, config);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );

  const isValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(parsed.signature),
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!isValid) return null;
  if (!validateClerkClaims(parsed.claims, config)) return null;

  return extractClerkIdentity(parsed.claims);
}

async function findOrProvisionClerkAuthUser(
  db: Db,
  identity: ClerkIdentity,
): Promise<BetterAuthSessionUser | null> {
  const existingByEmailRows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
    })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${identity.email}`);
  const existingByEmail = existingByEmailRows[0] ?? null;

  if (existingByEmail) {
    return {
      id: existingByEmail.id,
      email: existingByEmail.email,
      name: existingByEmail.name,
    };
  }

  const now = new Date();
  const provisionedUserId = generateId();
  const provisionedName = identity.name?.trim() || identity.email.split("@")[0] || `user-${generateId()}`;

  await db.insert(authUsers).values({
    id: provisionedUserId,
    name: provisionedName,
    email: identity.email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id: provisionedUserId,
    email: identity.email,
    name: provisionedName,
  };
}

export function extractBearerTokenFromHeaders(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function extractBearerTokenFromRequest(req: ExpressRequest): string | null {
  return extractBearerTokenFromHeaders(headersFromExpressRequest(req));
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

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins?: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "paperclip-dev-secret";
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);

  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const authConfig = {
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
    ...(isHttpOnly ? { advanced: { useSecureCookies: false } } : {}),
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
  req: ExpressRequest,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}

export async function resolveClerkSessionFromHeaders(
  db: Db,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const token = extractBearerTokenFromHeaders(headers);
  if (!token) return null;

  let identity: ClerkIdentity | null = null;
  try {
    identity = await verifyClerkJwt(token);
  } catch {
    return null;
  }
  if (!identity) return null;

  const user = await findOrProvisionClerkAuthUser(db, identity);
  if (!user) return null;

  return {
    session: {
      id: `clerk:${identity.subject}`,
      userId: user.id,
    },
    user,
  };
}

export async function resolveClerkSession(
  db: Db,
  req: ExpressRequest,
): Promise<BetterAuthSessionResult | null> {
  return resolveClerkSessionFromHeaders(db, headersFromExpressRequest(req));
}

export async function resolveAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  db: Db,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  if (extractBearerTokenFromHeaders(headers)) {
    const clerkSession = await resolveClerkSessionFromHeaders(db, headers);
    if (clerkSession) return clerkSession;
  }

  return resolveBetterAuthSessionFromHeaders(auth, headers);
}

export async function resolveAuthSession(
  auth: BetterAuthInstance,
  db: Db,
  req: ExpressRequest,
): Promise<BetterAuthSessionResult | null> {
  return resolveAuthSessionFromHeaders(auth, db, headersFromExpressRequest(req));
}

export function resetClerkJwksCacheForTests() {
  clerkJwksCache = null;
}
