import { Router, type Request, type Response } from "express";
import type { ProviderRegistry } from "../oauth/registry.js";
import type { RegisteredProvider } from "../oauth/types.js";
import type { SlidingWindowLimiter } from "../oauth/rate-limiter.js";
import { generateCodeVerifier, deriveCodeChallenge } from "../oauth/pkce.js";
import { validateReturnUrl } from "../oauth/redirect-allowlist.js";
import { oauthAuthorizationStates, oauthConnections } from "@paperclipai/db/schema/oauth";
import { and, eq } from "drizzle-orm";
import { revokeUpstreamToken } from "../oauth/revoke.js";
import { oauthLogger } from "../oauth/logger.js";
import { refreshConnection } from "../oauth/refresh.js";
import { backoffSeconds } from "../oauth/backoff.js";

// Narrow method-bag used by OAuth routes — keep this loose so route code does
// not pull the full secretService type, and so tests can substitute a stub.
export interface OAuthRouteSecretService {
  upsertSecretByName: (
    companyId: string,
    input: { name: string; value: string },
  ) => Promise<{ id: string }>;
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
  remove: (secretId: string) => Promise<unknown>;
  getById: (id: string) => Promise<{ id: string; latestVersion: number } | null>;
}

export interface OAuthRouteDeps {
  registry: ProviderRegistry;
  // db: Drizzle handle (typed via @paperclipai/db); kept loose here so the
  // router factory does not require pulling the full Db type into route code.
  db: any;
  publicUrl: string;
  rateLimiter: SlidingWindowLimiter;
  // Optional per-tenant flood limiter for `POST /connect/:providerId`. Keyed
  // by `companyId`, this guards against `oauth_authorization_states` row-flood
  // abuse (50 / 5min per spec §10.4). Optional so existing test harnesses and
  // older app.ts wirings continue to work; production wires it in app.ts.
  connectFloodLimiter?: SlidingWindowLimiter;
  // The connect route does not use secretService, so the bag is partial here.
  // Routes that need a method assert it at call time.
  secretService: Partial<OAuthRouteSecretService>;
  // Optional injection for tests; defaults to the real refreshConnection.
  refreshFn?: typeof refreshConnection;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function summary(p: RegisteredProvider) {
  return {
    id: p.config.id,
    displayName: p.config.displayName,
    iconUrl: p.config.iconUrl,
    docUrl: p.config.docUrl,
    scopesOffered: p.config.scopes.offered,
    scopesDefault: p.config.scopes.default,
  };
}

type ActorMembership = {
  companyId: string;
  membershipRole?: string | null;
  status?: string;
};

const ADMIN_ROLES = new Set(["owner", "admin"]);

function actorMembership(req: Request, companyId: string): ActorMembership | null {
  const actor = (req as Request & {
    actor?: { type: string; memberships?: ActorMembership[] };
  }).actor;
  if (!actor || actor.type !== "board") return null;
  return (actor.memberships ?? []).find((m) => m.companyId === companyId) ?? null;
}

function ensureMember(req: Request, res: Response): boolean {
  // Whitelist (not blacklist) the legitimate human-admin actor type. The
  // OAuth admin routes are board-only; allowing any other actor (e.g. an
  // `agent` token without `memberships`) past the type check would let it
  // reach the membership lookup and surface a 404 — leaking resource
  // existence — instead of being rejected with 401. Be strict here.
  const actor = (req as Request & { actor?: { type: string } }).actor;
  if (!actor || actor.type !== "board") {
    res.status(401).json({ errorCode: "unauthenticated" });
    return false;
  }
  const companyId = (req.params as unknown as { companyId: string }).companyId;
  if (!actorMembership(req, companyId)) {
    // 404 not 403, per spec 9.8
    res.status(404).end();
    return false;
  }
  return true;
}

// Like `ensureMember` but additionally requires the caller is an admin/owner
// of the company. Used by routes that mutate state (initiate connect,
// disconnect, manual refresh) — the UI hides these from non-admins, but the
// server is the source of truth.
function ensureCompanyAdmin(req: Request, res: Response): boolean {
  const actor = (req as Request & { actor?: { type: string } }).actor;
  if (!actor || actor.type !== "board") {
    res.status(401).json({ errorCode: "unauthenticated" });
    return false;
  }
  const companyId = (req.params as unknown as { companyId: string }).companyId;
  const membership = actorMembership(req, companyId);
  if (!membership) {
    res.status(404).end();
    return false;
  }
  if (!ADMIN_ROLES.has(String(membership.membershipRole ?? ""))) {
    res.status(403).json({ errorCode: "forbidden" });
    return false;
  }
  return true;
}

function isCompanyAdmin(req: Request, companyId: string): boolean {
  const membership = actorMembership(req, companyId);
  return ADMIN_ROLES.has(String(membership?.membershipRole ?? ""));
}

export function oauthRoutes(deps: OAuthRouteDeps): Router {
  const r = Router({ mergeParams: true });

  r.get("/providers", (req, res) => {
    if (!ensureMember(req, res)) return;
    res.json({ providers: deps.registry.list().map(summary) });
  });

  r.get("/providers/:providerId", (req, res) => {
    if (!ensureMember(req, res)) return;
    const p = deps.registry.get(req.params.providerId);
    if (!p) {
      res.status(404).json({ errorCode: "provider_not_found" });
      return;
    }
    res.json(summary(p));
  });

  r.post("/connect/:providerId", async (req, res) => {
    if (!ensureCompanyAdmin(req, res)) return;
    const provider = deps.registry.get(req.params.providerId);
    if (!provider) {
      res.status(404).json({ errorCode: "provider_not_found" });
      return;
    }

    const actor = (req as Request & { actor: { userId: string } }).actor;
    if (deps.connectFloodLimiter) {
      const floodOk = await deps.connectFloodLimiter.check(
        `connect-flood:${(req.params as unknown as { companyId: string }).companyId}`,
      );
      if (!floodOk) {
        res.status(429).json({ errorCode: "connect_flood" });
        return;
      }
    }
    const ok = await deps.rateLimiter.check(`connect:${actor.userId}`);
    if (!ok) {
      res.status(429).json({ errorCode: "rate_limited" });
      return;
    }

    const { scopes, returnUrl } = (req.body ?? {}) as {
      scopes?: unknown;
      returnUrl?: unknown;
    };
    const requestedScopes =
      Array.isArray(scopes) && scopes.every((s) => typeof s === "string")
        ? (scopes as string[])
        : provider.config.scopes.default;
    const offered = new Set(provider.config.scopes.offered);
    if (!requestedScopes.every((s) => offered.has(s))) {
      res.status(400).json({ errorCode: "invalid_scope" });
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    const redirectUri = `${deps.publicUrl}/api/oauth/callback/${provider.config.id}`;
    const safeReturnUrl =
      typeof returnUrl === "string"
        ? validateReturnUrl(returnUrl, deps.publicUrl)
        : "/settings/connections";
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    const companyId = (req.params as unknown as { companyId: string }).companyId;
    const [row] = await deps.db
      .insert(oauthAuthorizationStates)
      .values({
        companyId,
        providerId: provider.config.id,
        codeVerifier: verifier,
        redirectUri,
        scopesRequested: requestedScopes,
        initiatedByUserId: actor.userId,
        returnUrl: safeReturnUrl,
        expiresAt,
      })
      .returning();

    const authorizeUrl = new URL(provider.config.endpoints.authorize);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", provider.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizeUrl.searchParams.set("state", row.id);
    if (provider.config.pkce !== "unsupported") {
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
    }

    res.json({ authorizeUrl: authorizeUrl.toString(), state: row.id });
  });

  r.get("/connections", async (req, res) => {
    if (!ensureMember(req, res)) return;
    const companyId = (req.params as unknown as { companyId: string }).companyId;
    const includeDiagnostics = isCompanyAdmin(req, companyId);
    const rows = await deps.db.query.oauthConnections.findMany({
      where: eq(oauthConnections.companyId, companyId),
    });
    res.json({
      connections: (rows as unknown[]).map((c) =>
        publicConnection(c, includeDiagnostics),
      ),
    });
  });

  r.get("/connections/:id", async (req, res) => {
    if (!ensureMember(req, res)) return;
    const companyId = (req.params as unknown as { companyId: string; id: string }).companyId;
    const row = await deps.db.query.oauthConnections.findFirst({
      where: and(
        eq(oauthConnections.id, req.params.id),
        eq(oauthConnections.companyId, companyId),
      ),
    });
    if (!row || (row as { companyId: string }).companyId !== companyId) {
      res.status(404).end();
      return;
    }
    res.json(publicConnection(row, isCompanyAdmin(req, companyId)));
  });

  r.post("/connections/:id/refresh", async (req, res) => {
    if (!ensureCompanyAdmin(req, res)) return;
    const companyId = (req.params as unknown as { companyId: string; id: string }).companyId;
    const conn = await deps.db.query.oauthConnections.findFirst({
      where: and(
        eq(oauthConnections.id, req.params.id),
        eq(oauthConnections.companyId, companyId),
      ),
    });
    if (!conn) {
      res.status(404).end();
      return;
    }
    const row = conn as {
      id: string;
      lastErrorAt: Date | null;
      refreshAttemptCount: number;
    };

    if (row.lastErrorAt) {
      const minRetryAt = new Date(
        row.lastErrorAt.getTime() + backoffSeconds(row.refreshAttemptCount) * 1000,
      );
      if (minRetryAt > new Date()) {
        const retryAfter = Math.ceil((minRetryAt.getTime() - Date.now()) / 1000);
        res.setHeader("retry-after", String(retryAfter));
        res.status(429).json({
          errorCode: "in_backoff",
          retryAfterSeconds: retryAfter,
        });
        return;
      }
    }

    const ok = await deps.rateLimiter.check(`refresh:${row.id}`);
    if (!ok) {
      res.status(429).json({ errorCode: "rate_limited" });
      return;
    }

    const refreshFn = deps.refreshFn ?? refreshConnection;
    // refreshConnection requires the full RefreshSecretService surface — at
    // wire time (T28) the real secretService satisfies this; tests inject a
    // stubbed refreshFn so the cast here is safe.
    const result = await refreshFn({
      connectionId: row.id,
      db: deps.db,
      registry: deps.registry,
      secretService: deps.secretService as unknown as Parameters<
        typeof refreshConnection
      >[0]["secretService"],
    });
    const updated = await deps.db.query.oauthConnections.findFirst({
      where: eq(oauthConnections.id, row.id),
    });
    if (!updated) {
      res.status(404).end();
      return;
    }
    if (result.outcome === "success") {
      res.json(publicConnection(updated, true));
      return;
    }
    if (result.outcome === "revoked") {
      res.status(409).json({
        errorCode: "connection_revoked",
        connection: publicConnection(updated, true),
      });
      return;
    }
    res.status(503).json({
      errorCode: "refresh_failed",
      connection: publicConnection(updated, true),
    });
  });

  r.delete("/connections/:id", async (req, res) => {
    if (!ensureCompanyAdmin(req, res)) return;
    const companyId = (req.params as unknown as { companyId: string; id: string }).companyId;
    const row = await deps.db.query.oauthConnections.findFirst({
      where: and(
        eq(oauthConnections.id, req.params.id),
        eq(oauthConnections.companyId, companyId),
      ),
    });
    if (!row) {
      res.status(404).end();
      return;
    }

    const conn = row as {
      id: string;
      providerId: string;
      accessTokenSecretId: string | null;
      refreshTokenSecretId: string | null;
    };

    const svc = deps.secretService;
    let accessToken: string | undefined;
    let refreshToken: string | undefined;

    if (conn.accessTokenSecretId && svc.resolveSecretValue && svc.getById) {
      try {
        const secret = await svc.getById(conn.accessTokenSecretId);
        const version = secret?.latestVersion ?? "latest";
        accessToken = await svc.resolveSecretValue(
          companyId,
          conn.accessTokenSecretId,
          version,
        );
      } catch (err) {
        oauthLogger.warn(
          {
            providerId: conn.providerId,
            err: { message: (err as Error).message },
          },
          "failed to resolve access token for upstream revoke; continuing",
        );
      }
    }

    if (conn.refreshTokenSecretId && svc.resolveSecretValue && svc.getById) {
      try {
        const secret = await svc.getById(conn.refreshTokenSecretId);
        const version = secret?.latestVersion ?? "latest";
        refreshToken = await svc.resolveSecretValue(
          companyId,
          conn.refreshTokenSecretId,
          version,
        );
      } catch (err) {
        oauthLogger.warn(
          {
            providerId: conn.providerId,
            err: { message: (err as Error).message },
          },
          "failed to resolve refresh token for upstream revoke; continuing",
        );
      }
    }

    const provider = deps.registry.get(conn.providerId);
    if (provider?.config.endpoints.revoke) {
      try {
        await revokeUpstreamToken({ provider, accessToken, refreshToken });
      } catch (err) {
        oauthLogger.warn(
          {
            providerId: conn.providerId,
            err: { message: (err as Error).message },
          },
          "upstream revoke failed; continuing local delete",
        );
      }
    }

    await deps.db.transaction(async (tx: any) => {
      await tx.delete(oauthConnections).where(eq(oauthConnections.id, conn.id));
    });

    if (conn.accessTokenSecretId && svc.remove) {
      try {
        await svc.remove(conn.accessTokenSecretId);
      } catch (err) {
        oauthLogger.warn(
          {
            secretId: conn.accessTokenSecretId,
            err: { message: (err as Error).message },
          },
          "secret remove failed during disconnect; continuing",
        );
      }
    }
    if (conn.refreshTokenSecretId && svc.remove) {
      try {
        await svc.remove(conn.refreshTokenSecretId);
      } catch (err) {
        oauthLogger.warn(
          {
            secretId: conn.refreshTokenSecretId,
            err: { message: (err as Error).message },
          },
          "secret remove failed during disconnect; continuing",
        );
      }
    }

    res.status(204).end();
  });

  return r;
}

function publicConnection(c: unknown, includeDiagnostics = false) {
  const row = c as {
    id: string;
    providerId: string;
    status: string;
    accountId: string | null;
    accountLabel: string | null;
    scopes: string[];
    accessTokenExpiresAt: Date | null;
    lastRefreshedAt: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    refreshAttemptCount: number;
    createdAt: Date;
    updatedAt: Date;
  };
  return {
    id: row.id,
    providerId: row.providerId,
    status: row.status,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    scopes: row.scopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    lastRefreshedAt: row.lastRefreshedAt,
    ...(includeDiagnostics
      ? {
          lastError: row.lastError,
          lastErrorAt: row.lastErrorAt,
        }
      : {}),
    refreshAttemptCount: row.refreshAttemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
