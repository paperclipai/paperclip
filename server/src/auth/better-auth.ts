import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
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
type BetterAuthAutoInstances = {
  secure: BetterAuthInstance;
  insecure: BetterAuthInstance;
};
type BetterAuthRuntime = BetterAuthInstance | BetterAuthAutoInstances;
type BetterAuthTransportContext = {
  encrypted?: boolean;
  protocol?: string | null;
  remoteAddress?: string | null;
};

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: {
  disableSecureCookies?: boolean;
  useSecureCookies?: boolean;
}) {
  const useSecureCookies = input.useSecureCookies ?? (input.disableSecureCookies ? false : undefined);
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(useSecureCookies === undefined ? {} : { useSecureCookies }),
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

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  return headersFromNodeHeaders(req.headers);
}

function isLoopbackAddress(remoteAddress: string | null | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1";
}

function forwardedProtoFromHeaders(headers: Headers): "http" | "https" | null {
  const value = headers.get("x-forwarded-proto");
  if (!value) return null;
  const proto = value.split(",")[0]?.trim().toLowerCase();
  return proto === "http" || proto === "https" ? proto : null;
}

function isTlsSocket(value: unknown): value is { encrypted?: boolean } {
  return typeof value === "object" && value !== null && "encrypted" in value;
}

export function shouldUseSecureCookiesForAutoMode(
  headers: Headers,
  transport: BetterAuthTransportContext = {},
): boolean {
  const forwardedProto = forwardedProtoFromHeaders(headers);
  if (forwardedProto && isLoopbackAddress(transport.remoteAddress)) {
    return forwardedProto === "https";
  }
  if (transport.protocol) {
    return transport.protocol === "https";
  }
  return transport.encrypted === true;
}

function selectBetterAuthInstance(
  auth: BetterAuthRuntime,
  headers: Headers,
  transport: BetterAuthTransportContext = {},
): BetterAuthInstance {
  if (!("secure" in auth) || !("insecure" in auth)) {
    return auth;
  }
  return shouldUseSecureCookiesForAutoMode(headers, transport) ? auth.secure : auth.insecure;
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

function createBetterAuthInstanceWithAdvancedOptions(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  advanced: ReturnType<typeof buildBetterAuthAdvancedOptions>,
): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
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
    advanced,
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  return createBetterAuthInstanceWithAdvancedOptions(
    db,
    config,
    trustedOrigins,
    buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  );
}

export function createAutoModeBetterAuthInstances(
  db: Db,
  config: Config,
  trustedOrigins: string[],
): BetterAuthAutoInstances {
  return {
    secure: createBetterAuthInstanceWithAdvancedOptions(
      db,
      config,
      trustedOrigins,
      buildBetterAuthAdvancedOptions({ useSecureCookies: true }),
    ),
    insecure: createBetterAuthInstanceWithAdvancedOptions(
      db,
      config,
      trustedOrigins,
      buildBetterAuthAdvancedOptions({ useSecureCookies: false }),
    ),
  };
}

export function createBetterAuthHandler(auth: BetterAuthRuntime): RequestHandler {
  if ("secure" in auth && "insecure" in auth) {
    const secureHandler = toNodeHandler(auth.secure);
    const insecureHandler = toNodeHandler(auth.insecure);
    return (req, res, next) => {
      const headers = headersFromExpressRequest(req);
      const selected = selectBetterAuthInstance(auth, headers, {
        encrypted: isTlsSocket(req.socket) ? req.socket.encrypted === true : false,
        protocol: req.protocol,
        remoteAddress: req.socket.remoteAddress ?? null,
      });
      const handler = selected === auth.secure ? secureHandler : insecureHandler;
      void Promise.resolve(handler(req, res)).catch(next);
    };
  }

  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthRuntime,
  headers: Headers,
  transport: BetterAuthTransportContext = {},
): Promise<BetterAuthSessionResult | null> {
  const authInstance = selectBetterAuthInstance(auth, headers, transport);
  const api = (authInstance as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
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

export async function resolveBetterAuthSessionFromRequest(
  auth: BetterAuthRuntime,
  req: IncomingMessage,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromIncomingMessage(req), {
    encrypted: isTlsSocket(req.socket) ? req.socket.encrypted === true : false,
    remoteAddress: req.socket.remoteAddress ?? null,
  });
}

export async function resolveBetterAuthSession(
  auth: BetterAuthRuntime,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req), {
    encrypted: isTlsSocket(req.socket) ? req.socket.encrypted === true : false,
    protocol: req.protocol,
    remoteAddress: req.socket.remoteAddress ?? null,
  });
}
